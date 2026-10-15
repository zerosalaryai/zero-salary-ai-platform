import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({
  handler: vi.fn(),
  boundary: vi.fn(),
  demo: vi.fn(),
  voiceGate: vi.fn(),
  prepare: vi.fn(),
  job: vi.fn(),
}));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: f.handler }));
vi.mock("@/lib/channels/demo-inbound-only", () => ({
  assertDemoOutbound: f.demo,
  assertDemoVoicePreparation: f.voiceGate,
}));
vi.mock("@/lib/atendimento/fronteira-server", () => ({
  requireCurrentServiceBoundary: f.boundary,
  guardServiceEffect: f.boundary,
  currentExecutionJob: f.job,
}));
vi.mock("@/lib/agent-engine/external/speech-artifact", () => ({
  prepareSpeechArtifact: f.prepare,
  assertSpeechAuthority: f.boundary,
}));
import { sendTurnMessage } from "@/lib/agent-engine/edge/crm/send-message";
import {
  loadExternalResponseBinding,
  sendWithLedger,
} from "@/lib/agent-engine/edge/crm/send-ledger";
import { preparedVoiceMatches } from "@/lib/agent-engine/external/voice-delivery";
const org = "20000000-0000-4000-8000-000000000001",
  conv = "20000000-0000-4000-8000-000000000002";
const inbound = "20000000-0000-4000-8000-000000000003",
  key = "20000000-0000-4000-8000-000000000004";
const voice = { inboundMessageId: inbound, language: "en" as const };
const reply = {
  schema_version: "2",
  request_id: "synthetic-request",
  trace_id: "synthetic-trace",
  status: "reply",
  reply: { type: "text", text: "Approved reply" },
  checkpoint: {
    commitments: [],
    objections: [],
    next_action: "Discuss needs",
    rolling_summary: "Synthetic",
    captured_facts: {},
  },
  handoff: null,
  actions: [],
};
const job = {
  id: "job",
  organization_id: org,
  kind: "inbound_turn",
  locked_by: "worker",
  claim_acquired_at: "2026-10-15 00:00:00+00",
  payload: { conversation_id: conv, inbound_message_id: inbound },
};
const input = {
  tenantId: org,
  leadId: "contact",
  jobId: job.id,
  seq: 1,
  conversationId: conv,
  body: "Approved reply",
  voice,
  acceptedResponse: reply,
};
const bytes = Buffer.from("OggSsyntheticOpusHead");
const hash = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const artifact = {
  type: "audio",
  media_storage_path: `${org}/${conv}/${key}.ogg`,
  media_mime: "audio/ogg;codecs=opus",
  media_size_bytes: bytes.length,
  audio_sha256: hash(bytes),
  text_sha256: hash(input.body),
  transcript: input.body,
  request_id: key,
};
function fixtures() {
  let state: unknown;
  let message: unknown = null;
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.startsWith("select payload,kind")) return { rows: [job] };
    if (sql.startsWith("insert into send_ledger")) {
      state = values![6] ? JSON.parse(values![6] as string) : null;
      return { rows: [{ id: key }] };
    }
    if (sql.startsWith("select l.voice_delivery")) return { rows: [{ voice_delivery: state }] };
    if (sql.startsWith("update public.send_ledger")) {
      state = JSON.parse(values![3] as string);
      return { rows: [{ id: key }] };
    }
    if (sql.startsWith("select id,status,external_id from messages"))
      return { rows: message ? [message] : [] };
    return { rows: [] };
  });
  const sb = {
    storage: {
      from: () => ({
        download: async () => ({ data: new Blob([new Uint8Array(bytes)]), error: null }),
      }),
    },
  };
  f.handler.mockImplementation(async () => {
    message = { id: key, status: "sent", external_id: "synthetic-meta-receipt" };
    return message;
  });
  return {
    query,
    db: { query } as never,
    cfg: {
      supabase: sb as never,
      speech: { baseUrl: "https://python.invalid", secret: "synthetic", allowlistTtlMs: 60000 },
    },
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  f.job.mockReturnValue(job);
  f.boundary.mockResolvedValue(undefined);
  f.demo.mockResolvedValue(undefined);
  f.voiceGate.mockResolvedValue(undefined);
  f.prepare.mockResolvedValue(artifact);
});
it("delivers private voice through the canonical handler with transcript and accepted checkpoint on the same intent", async () => {
  const x = fixtures();
  f.handler.mockImplementation(async (_sb, ctx, body) => {
    expect(preparedVoiceMatches(org, conv, artifact.media_storage_path)).toBe(true);
    expect(ctx.internalMessageId).toBe(key);
    expect(body).toMatchObject({
      type: "audio",
      body: input.body,
      media_storage_path: artifact.media_storage_path,
      media_mime: "audio/ogg;codecs=opus",
      metadata: { idempotency_key: key, voice_reply_intent: key },
    });
    return { id: key, status: "sent", external_id: "synthetic-meta-receipt" };
  });
  expect((await sendTurnMessage(x.db, x.cfg, input)).kind).toBe("sent");
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(f.handler).toHaveBeenCalledOnce();
  const args = x.query.mock.calls.find(([sql]) => sql.startsWith("insert into send_ledger"))![1]!;
  expect(JSON.parse(args[5] as string)).toEqual(reply);
});
it("keeps text delivery free of TTS/artifacts", async () => {
  const x = fixtures();
  const { voice: _voice, ...text } = input;
  await sendTurnMessage(x.db, x.cfg, text);
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.handler.mock.calls[0]![2]).toMatchObject({ type: "text", body: input.body });
  expect(f.handler.mock.calls[0]![2]).not.toHaveProperty("media_storage_path");
});
it.each(["boundary", "demo", "gate"])("denies %s before speech preparation", async (which) => {
  const x = fixtures();
  ({ boundary: f.boundary, demo: f.demo, gate: f.voiceGate })[which]!.mockRejectedValue(
    Error("denied"),
  );
  await expect(sendTurnMessage(x.db, x.cfg, input)).rejects.toThrow("denied");
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.handler).not.toHaveBeenCalled();
});
it("requires a valid v2 accepted candidate and configured speech service", async () => {
  const x = fixtures();
  await expect(sendTurnMessage(x.db, x.cfg, { ...input, acceptedResponse: null })).rejects.toThrow(
    "voice_delivery_configuration_denied",
  );
  await expect(sendTurnMessage(x.db, { supabase: x.cfg.supabase }, input)).rejects.toThrow(
    "voice_delivery_configuration_denied",
  );
  expect(f.prepare).not.toHaveBeenCalled();
});
it.each(["reserved", "ready", "preparing", "attempted"])(
  "recovers %s without regenerating a different checkpoint",
  async (state) => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("from send_ledger")
        ? [{ id: key, status: "requested", external_response: reply, voice_delivery: { state } }]
        : [],
    }));
    expect(
      await loadExternalResponseBinding({ query } as never, { tenantId: org, jobId: job.id }),
    ).toEqual({
      kind: ["reserved", "ready"].includes(state) ? "prepared" : "pending",
      response: reply,
    });
  },
);
it("reconciles accepted voice receipt without another transport", async () => {
  const store: Parameters<typeof sendWithLedger>[0] = {
    create: vi.fn(async () => {
      throw { code: "23505" };
    }),
    find: vi.fn(async () => ({
      id: key,
      status: "requested" as const,
      crm_message_id: null,
      voice_delivery: { state: "attempted", voice },
      body_hash: hash(input.body),
      external_response: reply,
    })),
    rotate: vi.fn(),
    message: vi.fn(async () => ({
      id: key,
      status: "sent",
      external_id: "synthetic-meta-receipt",
    })),
    update: vi.fn(),
  };
  const send = vi.fn();
  expect((await sendWithLedger(store, input, send)).kind).toBe("sent");
  expect(send).not.toHaveBeenCalled();
  expect(store.rotate).not.toHaveBeenCalled();
});
it("never rotates a failed voice attempt or changes its frozen response", async () => {
  const store: Parameters<typeof sendWithLedger>[0] = {
    create: vi.fn(async () => {
      throw { code: "23505" };
    }),
    find: vi.fn(async () => ({
      id: key,
      status: "failed" as const,
      crm_message_id: null,
      voice_delivery: { state: "attempted", voice },
      body_hash: hash(input.body),
      external_response: reply,
    })),
    rotate: vi.fn(),
    message: vi.fn(),
    update: vi.fn(),
  };
  await expect(sendWithLedger(store, input, vi.fn())).rejects.toThrow("voice_delivery_uncertain");
  await expect(sendWithLedger(store, { ...input, body: "different" }, vi.fn())).rejects.toThrow(
    "voice_intent_changed",
  );
  expect(store.rotate).not.toHaveBeenCalled();
});
it("never accepts a voice send or recovers its checkpoint without a provider receipt", async () => {
  const store: Parameters<typeof sendWithLedger>[0] = {
    create: vi.fn(async () => key),
    find: vi.fn(),
    rotate: vi.fn(),
    message: vi.fn(async () => null),
    update: vi.fn(),
  };
  await expect(
    sendWithLedger(store, input, async () => ({ id: key, status: "sent", external_id: null })),
  ).rejects.toThrow("voice_delivery_receipt_uncertain");
  expect(store.update).not.toHaveBeenCalled();
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes("from send_ledger")
      ? [
          {
            id: key,
            status: "requested",
            external_response: reply,
            voice_delivery: { state: "attempted" },
          },
        ]
      : [{ id: key, status: "sent", external_id: null }],
  }));
  expect(
    await loadExternalResponseBinding({ query } as never, { tenantId: org, jobId: job.id }),
  ).toEqual({ kind: "pending", response: reply });
});
