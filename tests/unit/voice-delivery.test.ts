import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ job: vi.fn(), guard: vi.fn(), prepare: vi.fn() }));
vi.mock("@/lib/atendimento/fronteira-server", () => ({
  currentExecutionJob: f.job,
  guardServiceEffect: f.guard,
}));
vi.mock("@/lib/agent-engine/external/speech-artifact", () => ({
  prepareSpeechArtifact: f.prepare,
  assertSpeechAuthority: f.guard,
}));
import {
  deliverVoice,
  preparedVoiceMatches,
  resolveVoiceReply,
} from "@/lib/agent-engine/external/voice-delivery";
import { reservedVoiceDelivery } from "@/lib/agent-engine/external/voice-contract";
import {
  assertDemoTransport,
  assertDemoVoicePreparation,
  withDemoInbound,
} from "@/lib/channels/demo-inbound-only";
import type { JobRow } from "@/lib/agent-engine/queue/queue";

const org = "10000000-0000-4000-8000-000000000001";
const conv = "10000000-0000-4000-8000-000000000002";
const inbound = "10000000-0000-4000-8000-000000000003";
const intent = "10000000-0000-4000-8000-000000000004";
const channel = "c67e9f8a-8719-4481-9154-ed8a464f85bd";
const contact = "10000000-0000-4000-8000-000000000005";
const event = "10000000-0000-4000-8000-000000000006";
const job = {
  id: "10000000-0000-4000-8000-000000000007",
  organization_id: org,
  contact_id: contact,
  kind: "inbound_turn",
  status: "running",
  priority: 100,
  run_after: new Date("2026-10-15T00:00:00Z"),
  attempts: 1,
  max_attempts: 5,
  last_error: null,
  created_at: new Date("2026-10-15T00:00:00Z"),
  locked_at: new Date("2026-10-15T00:00:00Z"),
  source_event_id: event,
  locked_by: "synthetic-worker",
  claim_acquired_at: "2026-10-15 00:00:00+00",
  payload: {
    inbound_message_id: inbound,
    conversation_id: conv,
    channel_session_id: channel,
    contact_id: contact,
  },
} as JobRow;
const voice = { inboundMessageId: inbound, language: "ml" as const };
const input = {
  request_id: intent,
  organization_id: org,
  conversation_id: conv,
  text: "അടുത്ത ഘട്ടം പറയാം",
  language: "ml" as const,
};
const bytes = Buffer.from("OggSsyntheticOpusHead");
const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const artifact = {
  type: "audio" as const,
  media_storage_path: `${org}/${conv}/${intent}.ogg`,
  media_mime: "audio/ogg;codecs=opus" as const,
  media_size_bytes: bytes.length,
  audio_sha256: hash(bytes),
  text_sha256: hash(input.text),
  transcript: input.text,
  request_id: intent,
};
const config = { baseUrl: "https://python.invalid", secret: "synthetic", allowlistTtlMs: 60000 };
const demoRow = {
  id: channel,
  organization_id: org,
  provider: "meta_cloud",
  phone_number: "+15555550230",
  metadata: { ai_gate: "open" },
  archived_at: null,
  meta_phone_number_id: "123456789",
  safe: true,
  recipient: "+15555550111",
  latest_body: "Need a demo",
  latest_inbound_id: inbound,
};
function fixtures(initial: unknown = reservedVoiceDelivery(voice)) {
  let state = structuredClone(initial);
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.startsWith("select l.voice_delivery"))
      return { rows: [{ voice_delivery: structuredClone(state) }] };
    if (sql.startsWith("update public.send_ledger")) {
      if (!isDeepStrictEqual(state, JSON.parse(values![4] as string))) return { rows: [] };
      state = JSON.parse(values![3] as string);
      return { rows: [{ id: intent }] };
    }
    if (sql.includes("select *, locked_at::text")) return { rows: [job] };
    if (sql.includes("select payload,kind"))
      return { rows: [{ payload: job.payload, kind: job.kind }] };
    return { rows: [demoRow] };
  });
  const download = vi.fn(async () => ({ data: new Blob([new Uint8Array(bytes)]), error: null }));
  const send = vi.fn(async () => ({ id: intent, status: "sent" }));
  return {
    query,
    download,
    send,
    db: { query } as never,
    sb: { storage: { from: () => ({ download }) } } as never,
    state: () => state,
    run() {
      return deliverVoice(this.db, this.sb, input, voice, config, this.send);
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  f.job.mockReturnValue(job);
  f.guard.mockResolvedValue(undefined);
  f.prepare.mockResolvedValue(artifact);
});
afterEach(() => vi.unstubAllEnvs());

it("prepares once, persists the exact artifact, fences the send, and scopes its capability", async () => {
  const x = fixtures();
  x.send.mockImplementation(async () => {
    expect(x.state()).toMatchObject({ state: "attempted", artifact });
    expect(preparedVoiceMatches(org, conv, artifact.media_storage_path)).toBe(true);
    expect(preparedVoiceMatches("foreign", conv, artifact.media_storage_path)).toBe(false);
    expect(preparedVoiceMatches(org, "foreign", artifact.media_storage_path)).toBe(false);
    expect(preparedVoiceMatches(org, conv, "foreign")).toBe(false);
    return { id: intent, status: "sent" };
  });
  await x.run();
  expect(f.prepare).toHaveBeenCalledExactlyOnceWith(x.db, x.sb, input, config);
  expect(x.send).toHaveBeenCalledExactlyOnceWith(artifact);
  expect(preparedVoiceMatches(org, conv)).toBe(false);
});
it("reuses a prepared artifact without another TTS or upload", async () => {
  const x = fixtures({ state: "ready", voice, artifact });
  await x.run();
  expect(f.prepare).not.toHaveBeenCalled();
  expect(x.download).toHaveBeenCalledOnce();
  expect(x.send).toHaveBeenCalledOnce();
});
it.each(["preparing", "attempted"])(
  "holds %s intent without resending or regenerating",
  async (state) => {
    const x = fixtures({ state, voice, ...(state === "attempted" ? { artifact } : {}) });
    await expect(x.run()).rejects.toThrow("voice_delivery_uncertain");
    expect(f.prepare).not.toHaveBeenCalled();
    expect(x.send).not.toHaveBeenCalled();
  },
);
it("holds an uncertain transport exception on the next retry", async () => {
  const x = fixtures();
  x.send.mockRejectedValue(Error("timeout"));
  await expect(x.run()).rejects.toThrow("timeout");
  await expect(x.run()).rejects.toThrow("voice_delivery_uncertain");
  expect(x.send).toHaveBeenCalledOnce();
  expect(f.prepare).toHaveBeenCalledOnce();
});
it("serializes concurrent deliveries before synthesis", async () => {
  const x = fixtures();
  let release!: (value: typeof artifact) => void;
  f.prepare.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const first = x.run();
  await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledOnce());
  await expect(x.run()).rejects.toThrow("voice_delivery_uncertain");
  release(artifact);
  await first;
  expect(x.send).toHaveBeenCalledOnce();
});
it("never retries partial preparation after a crash/failure", async () => {
  const x = fixtures();
  f.prepare.mockRejectedValue(Error("storage commit uncertain"));
  await expect(x.run()).rejects.toThrow("storage commit uncertain");
  await expect(x.run()).rejects.toThrow("voice_delivery_uncertain");
  expect(x.send).not.toHaveBeenCalled();
});
it.each([
  null,
  { ...job, organization_id: "foreign" },
  { ...job, payload: { ...job.payload, inbound_message_id: intent } },
  { ...job, claim_acquired_at: undefined },
])("denies invalid execution identity", async (context) => {
  const x = fixtures();
  f.job.mockReturnValue(context);
  await expect(x.run()).rejects.toThrow("voice_execution_denied");
  expect(x.query).not.toHaveBeenCalled();
});
it("denies a changed service boundary/takeover after preparation", async () => {
  const x = fixtures();
  f.guard.mockResolvedValueOnce(undefined).mockRejectedValueOnce(Error("service_boundary_stale"));
  await expect(x.run()).rejects.toThrow("service_boundary_stale");
  expect(x.send).not.toHaveBeenCalled();
  expect(x.state()).toMatchObject({ state: "ready" });
});
it("fails closed on a DB error, missing binding or lost claim", async () => {
  for (const failure of [Error("db unavailable"), null]) {
    const x = fixtures();
    if (failure) x.query.mockRejectedValue(failure);
    else x.query.mockResolvedValue({ rows: [] } as never);
    await expect(x.run()).rejects.toThrow();
    expect(x.send).not.toHaveBeenCalled();
  }
});
it("rejects foreign artifact paths and corrupt stored bytes before transport", async () => {
  const foreign = fixtures({
    state: "ready",
    voice,
    artifact: { ...artifact, media_storage_path: "foreign/audio.ogg" },
  });
  await expect(foreign.run()).rejects.toThrow("voice_artifact_binding_denied");
  const corrupt = fixtures({ state: "ready", voice, artifact });
  corrupt.download.mockResolvedValue({
    data: new Blob([new Uint8Array(Buffer.alloc(bytes.length))]),
    error: null,
  });
  await expect(corrupt.run()).rejects.toThrow("voice_artifact_digest_mismatch");
  expect(corrupt.send).not.toHaveBeenCalled();
});
it("keeps audio/text modality from tenant-scoped durable rows and channel policy", async () => {
  const db = { query: vi.fn() };
  const args = {
    organizationId: org,
    conversationId: conv,
    inboundMessageId: inbound,
    language: "malayalam",
  };
  db.query.mockResolvedValue({ rows: [{ type: "audio", mode: "match_input" }] });
  expect(await resolveVoiceReply(db as never, args)).toEqual(voice);
  expect(db.query.mock.calls[0]![1]).toEqual([org, conv, inbound]);
  for (const row of [
    { type: "text", mode: "match_input" },
    { type: "audio", mode: "text" },
    { type: "audio", mode: null },
  ]) {
    db.query.mockResolvedValue({ rows: [row] });
    expect(await resolveVoiceReply(db as never, args)).toBeUndefined();
  }
  db.query.mockResolvedValue({ rows: [{ type: "audio", mode: "match_input" }] });
  await expect(resolveVoiceReply(db as never, { ...args, language: "arabic" })).rejects.toThrow(
    "voice_reply_language_unsupported",
  );
  db.query.mockResolvedValue({ rows: [] });
  await expect(resolveVoiceReply(db as never, args)).rejects.toThrow(
    "voice_inbound_binding_denied",
  );
});
it("allows demo audio only with explicit exact 0230 gate, current demo job and prepared capability", async () => {
  vi.stubEnv("DEMO_INBOUND_ONLY", "true");
  vi.stubEnv("DEMO_CHANNEL_ID", channel);
  const x = fixtures();
  const binding = { channelId: channel, organizationId: org, startedAt: "2026-10-15T00:00:00Z" };
  await withDemoInbound(x.db, binding, job, async () => {
    await expect(assertDemoVoicePreparation(org, conv)).rejects.toThrow();
    vi.stubEnv("DEMO_VOICE_REPLY_CHANNEL_ID", channel);
    await assertDemoVoicePreparation(org, conv);
    await expect(
      assertDemoTransport({
        organizationId: org,
        sessionRef: "123456789",
        to: demoRow.recipient.replace(/\D/g, ""),
        kind: "audio",
      }),
    ).rejects.toThrow();
    x.send.mockImplementation(async () => {
      await assertDemoTransport({
        organizationId: org,
        sessionRef: "123456789",
        to: demoRow.recipient.replace(/\D/g, ""),
        kind: "audio",
      });
      await expect(
        assertDemoTransport({
          organizationId: org,
          sessionRef: "7270",
          to: demoRow.recipient.replace(/\D/g, ""),
          kind: "audio",
        }),
      ).rejects.toThrow();
      await expect(
        assertDemoTransport({
          organizationId: "foreign",
          sessionRef: "123456789",
          to: demoRow.recipient.replace(/\D/g, ""),
          kind: "audio",
        }),
      ).rejects.toThrow();
      return { id: intent, status: "sent" };
    });
    await x.run();
  });
  expect(x.send).toHaveBeenCalledOnce();
});

it("never permits speech preparation in the dedicated demo Web process", async () => {
  vi.stubEnv("DEMO_WEB_INGRESS_ONLY", "true");
  vi.stubEnv("DEMO_WEB_CHANNEL_ID", channel);
  vi.stubEnv("DEMO_INBOUND_ONLY", "false");
  await expect(assertDemoVoicePreparation(org, conv)).rejects.toThrow("demo_web_ingress_denied");
  expect(f.prepare).not.toHaveBeenCalled();
});

it("the real canonical handler rejects forged voice metadata before any database access", async () => {
  vi.stubEnv("DEMO_INBOUND_ONLY", "false");
  const { sendMessageHandler } = await import("@/app/api/v1/messages/_handler");
  const access = vi.fn(() => {
    throw Error("database forbidden");
  });
  await expect(
    sendMessageHandler(
      { from: access } as never,
      {
        organization_id: org,
        actor: { type: "ai_agent", id: "synthetic", role: "manager" },
        requestId: intent,
      },
      {
        conversation_id: conv,
        type: "audio",
        body: input.text,
        media_storage_path: artifact.media_storage_path,
        media_mime: artifact.media_mime,
        metadata: { voice_reply_intent: intent },
      },
    ),
  ).rejects.toThrow("demo_inbound_only_denied");
  expect(access).not.toHaveBeenCalled();
});
