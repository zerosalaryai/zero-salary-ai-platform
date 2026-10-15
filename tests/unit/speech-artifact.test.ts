import { createHash } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ job: vi.fn(), guard: vi.fn(), eligibility: vi.fn() }));
vi.mock("@/lib/atendimento/fronteira-server", () => ({
  currentExecutionJob: f.job,
  guardServiceEffect: f.guard,
}));
vi.mock("@/lib/ai/elegibilidade/consulta-pg", () => ({
  decidirElegibilidadeDaConversa: f.eligibility,
}));
import { prepareSpeechArtifact, renderSpeech } from "@/lib/agent-engine/external/speech-artifact";
import { pythonAgentSignature } from "@/lib/agent-engine/external/python-agent-client";
const input = {
  request_id: "10000000-0000-4000-8000-000000000001",
  organization_id: "20000000-0000-4000-8000-000000000001",
  conversation_id: "30000000-0000-4000-8000-000000000001",
  text: "ഒരു ഡെമോ വേണം",
  language: "ml" as const,
};
const audio = Buffer.from("OggSsyntheticOpusHead");
const hash = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
function response(extra: Record<string, string> = {}, bytes = audio) {
  return new Response(new Uint8Array(bytes), {
    headers: {
      "content-type": "audio/ogg;codecs=opus",
      "x-zsai-request-id": input.request_id,
      "x-zsai-organization-id": input.organization_id,
      "x-zsai-text-sha256": hash(input.text),
      "x-zsai-audio-sha256": hash(bytes),
      ...extra,
    },
  });
}
function fixtures() {
  const fetchMock = vi.fn().mockResolvedValue(response());
  const query = vi.fn().mockResolvedValue({ rows: [{ id: input.request_id }] });
  const upload = vi.fn().mockResolvedValue({ error: null });
  const from = vi.fn(() => ({ upload }));
  return {
    fetchMock,
    query,
    upload,
    from,
    db: { query } as never,
    sb: { storage: { from } } as never,
    config: {
      baseUrl: "https://python.invalid",
      secret: "synthetic-secret",
      allowlistTtlMs: 60000,
      fetch: fetchMock,
      now: () => new Date(1000000),
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  f.job.mockReturnValue({
    id: "synthetic-job",
    payload: { conversation_id: input.conversation_id, inbound_message_id: input.request_id },
    locked_by: "synthetic-worker",
    claim_acquired_at: "2026-10-15 00:00:00+00",
    kind: "inbound_turn",
    organization_id: input.organization_id,
  });
  f.guard.mockResolvedValue(undefined);
  f.eligibility.mockResolvedValue({ permite: true });
});
afterEach(() => vi.unstubAllGlobals());
it("signs the exact tenant-bound speech request and validates its binary response", async () => {
  const x = fixtures();
  expect(await renderSpeech(input, x.config)).toEqual(audio);
  const [url, init] = x.fetchMock.mock.calls[0]!;
  expect(String(url)).toBe("https://python.invalid/internal/speech");
  const body = JSON.parse(init.body);
  expect(body.purpose).toBe("speech");
  expect(body.organization_id).toBe(input.organization_id);
  expect(init.headers["X-ZSAI-Signature"]).toBe(
    pythonAgentSignature("synthetic-secret", "1000", input.request_id, init.body),
  );
  expect(init.redirect).toBe("error");
  expect(init.signal).toBeInstanceOf(AbortSignal);
});
const invalidHeaders: Record<string, string>[] = [
  { "x-zsai-organization-id": "foreign" },
  { "x-zsai-request-id": "foreign" },
  { "x-zsai-text-sha256": "wrong" },
  { "content-type": "audio/wav" },
  { "x-zsai-audio-sha256": "wrong" },
];
it.each(invalidHeaders)("rejects mismatching response identity/content: %j", async (headers) => {
  const x = fixtures();
  x.fetchMock.mockResolvedValue(response(headers));
  await expect(renderSpeech(input, x.config)).rejects.toThrow();
});
it("bounds streamed response bytes", async () => {
  const x = fixtures();
  x.fetchMock.mockResolvedValue(response({}, Buffer.alloc(2 * 1024 * 1024 + 1)));
  await expect(renderSpeech(input, x.config)).rejects.toThrow("speech_response_too_large");
});
it("stores private audio under the authorized tenant/conversation/intent only", async () => {
  const x = fixtures();
  const result = await prepareSpeechArtifact(x.db, x.sb, input, x.config);
  expect(result.media_storage_path).toBe(
    `${input.organization_id}/${input.conversation_id}/${input.request_id}.ogg`,
  );
  expect(result.transcript).toBe(input.text);
  expect(x.from).toHaveBeenCalledWith("whatsapp-media");
  expect(x.upload).toHaveBeenCalledWith(result.media_storage_path, audio, {
    contentType: "audio/ogg;codecs=opus",
    upsert: false,
  });
  expect(x.query).toHaveBeenCalledTimes(2);
  expect(f.guard).toHaveBeenCalledTimes(2);
  expect(x.query.mock.calls[0]![0]).toContain("l.organization_id=$2");
  expect(x.query.mock.calls[0]![1]).toEqual([
    input.request_id,
    input.organization_id,
    "synthetic-job",
    hash(input.text),
    input.conversation_id,
    "synthetic-worker",
    "2026-10-15 00:00:00+00",
    input.request_id,
  ]);
});
it("rejects absent or foreign execution context before generation", async () => {
  for (const context of [
    null,
    { id: "foreign", kind: "inbound_turn", organization_id: "foreign" },
  ]) {
    const x = fixtures();
    f.job.mockReturnValue(context);
    await expect(prepareSpeechArtifact(x.db, x.sb, input, x.config)).rejects.toThrow(
      "speech_context_denied",
    );
    expect(x.fetchMock).not.toHaveBeenCalled();
  }
});
it("requires a matching ledger/conversation row before generation", async () => {
  const x = fixtures();
  x.query.mockResolvedValue({ rows: [] });
  await expect(prepareSpeechArtifact(x.db, x.sb, input, x.config)).rejects.toThrow(
    "speech_scope_denied",
  );
  expect(x.fetchMock).not.toHaveBeenCalled();
});
it("denies storage if handoff or boundary changes during synthesis", async () => {
  const x = fixtures();
  f.guard.mockResolvedValueOnce(undefined).mockRejectedValueOnce(Error("service_boundary_stale"));
  await expect(prepareSpeechArtifact(x.db, x.sb, input, x.config)).rejects.toThrow(
    "service_boundary_stale",
  );
  expect(x.upload).not.toHaveBeenCalled();
});
it("never overwrites or adopts an existing conflicting artifact", async () => {
  const x = fixtures();
  x.upload.mockResolvedValue({ error: { message: "conflict" } });
  await expect(prepareSpeechArtifact(x.db, x.sb, input, x.config)).rejects.toThrow(
    "speech_artifact_storage_failed",
  );
});

it("fails closed on eligibility denial or uncertainty before generation", async () => {
  for (const decision of [null, { permite: false }]) {
    const x = fixtures();
    f.eligibility.mockResolvedValue(decision);
    await expect(prepareSpeechArtifact(x.db, x.sb, input, x.config)).rejects.toThrow(
      "speech_eligibility_denied",
    );
    expect(x.fetchMock).not.toHaveBeenCalled();
    expect(x.upload).not.toHaveBeenCalled();
  }
});
