import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readDemoConfig,
  bindDemoChannel,
  assertDemoInbound,
  withDemoInbound,
  assertDemoOutbound,
  assertDemoTransport,
  assertDemoBeforeSend,
  denyDemoAutomation,
  DemoIsolationError,
  type DemoBinding,
} from "@/lib/channels/demo-inbound-only";
import type { JobRow, Queryable } from "@/lib/agent-engine/queue/queue";

// Canal permitido exato; demais identidades e respostas de banco são sintéticas.
const channel = "c67e9f8a-8719-4481-9154-ed8a464f85bd";
const other = "df10c6c2-0000-4000-8000-000000000002";
const org = "11000000-0000-4000-8000-000000000003";
const conv = "11000000-0000-4000-8000-000000000004";
const contact = "11000000-0000-4000-8000-000000000005";
const message = "11000000-0000-4000-8000-000000000006";
const event = "11000000-0000-4000-8000-000000000007";
const binding: DemoBinding = {
  channelId: channel,
  organizationId: org,
  startedAt: "2026-10-10T00:00:00Z",
};
const job = {
  id: "11000000-0000-4000-8000-000000000008",
  organization_id: org,
  contact_id: contact,
  kind: "inbound_turn",
  source_event_id: event,
  status: "running",
  locked_by: "demo-worker",
  priority: 100,
  run_after: new Date(),
  attempts: 1,
  max_attempts: 5,
  last_error: null,
  created_at: new Date(),
  locked_at: new Date("2026-10-10T00:01:00Z"),
  claim_acquired_at: "2026-10-10 00:01:00.123456+00",
  payload: {
    conversation_id: conv,
    contact_id: contact,
    channel_session_id: channel,
    inbound_message_id: message,
  },
} as JobRow;
const input = {
  organizationId: org,
  conversationId: conv,
  contactId: contact,
  channelId: channel,
  inboundMessageId: message,
  eventId: event,
};
const row = {
  id: channel,
  organization_id: org,
  provider: "meta_cloud",
  phone_number: "+15555550230",
  metadata: { ai_gate: "open" },
  archived_at: null,
  meta_phone_number_id: "123456789",
  started_at: binding.startedAt,
  safe: true,
  recipient: "+15555550111",
  latest_body: "Hello",
  latest_inbound_id: message,
};
function db(over = {}, currentJob = job) {
  return {
    query: vi.fn(async (sql: string) => ({
      rows: sql.startsWith("select *, locked_at::text") ? [currentJob] : [{ ...row, ...over }],
    })),
  } as unknown as Queryable;
}
function enable() {
  vi.stubEnv("DEMO_INBOUND_ONLY", "true");
  vi.stubEnv("DEMO_CHANNEL_ID", channel);
}
afterEach(() => vi.unstubAllEnvs());

describe("configuração e identidade de demo", () => {
  it("normal é default; só true explícito liga", () => {
    expect(readDemoConfig({})).toBeNull();
    expect(readDemoConfig({ DEMO_INBOUND_ONLY: "false", DEMO_CHANNEL_ID: "invalid" })).toBeNull();
    expect(readDemoConfig({ DEMO_INBOUND_ONLY: "true", DEMO_CHANNEL_ID: channel })).toEqual({
      channelId: channel,
    });
  });
  it.each([
    undefined,
    "",
    "c67e9f8a",
    "c67e9f8a-0000-4000-8000-000000000001",
    other,
    `${channel},${other}`,
    "not-a-uuid",
  ])("UUID completo ausente/inválido/ambíguo %s é recusado", (id) => {
    expect(() => readDemoConfig({ DEMO_INBOUND_ONLY: "true", DEMO_CHANNEL_ID: id })).toThrow(
      DemoIsolationError,
    );
  });
  it.each(["1", "yes", "TRUE", "unknown"])("opt-in inválido %s é recusado", (value) => {
    expect(() => readDemoConfig({ DEMO_INBOUND_ONLY: value, DEMO_CHANNEL_ID: channel })).toThrow();
  });
  it("0230 requer linha real única e o relógio do banco", async () => {
    const store = db();
    expect(await bindDemoChannel(store, { channelId: channel })).toEqual(binding);
    expect(store.query).toHaveBeenCalledWith(expect.stringContaining("clock_timestamp()"), [
      channel,
    ]);
  });
  it.each([
    { id: other },
    { phone_number: "+15555557270" },
    { metadata: { ai_gate: "off" } },
    { provider: "waha" },
    { archived_at: binding.startedAt },
    { phone_number: null },
    { meta_phone_number_id: null },
    { organization_id: "invalid" },
    { started_at: null },
  ])("binding inconsistente falha fechado %j", async (over) => {
    await expect(bindDemoChannel(db(over), { channelId: channel })).rejects.toThrow();
  });
  it.each([{ rows: [] }, { rows: [row, row] }])(
    "binding ausente ou ambíguo falha fechado",
    async ({ rows }) => {
      await expect(
        bindDemoChannel({ query: vi.fn(async () => ({ rows })) } as never, { channelId: channel }),
      ).rejects.toThrow();
    },
  );
});

describe("origem inbound e corte final", () => {
  it("0230 aberto permite apenas a sessão e o destinatário revalidados", async () => {
    enable();
    const store = db();
    const sent = vi.fn();
    await withDemoInbound(store, binding, job, async () => {
      await assertDemoOutbound(org, conv, job.id);
      await assertDemoBeforeSend({
        tenantId: org,
        leadId: contact,
        channelSessionId: channel,
        jobId: job.id,
      });
      await assertDemoTransport({
        organizationId: org,
        sessionRef: row.meta_phone_number_id,
        to: "15555550111",
        kind: "text",
      });
      sent();
    });
    expect(sent).toHaveBeenCalledOnce();
    expect(store.query).toHaveBeenCalledWith(
      expect.stringContaining("m.direction='inbound'"),
      expect.arrayContaining([channel, event, binding.startedAt]),
    );
  });
  it("tenant diferente é recusado antes de consultar o banco", async () => {
    const store = db();
    await expect(
      assertDemoInbound(store, binding, { ...input, organizationId: other }),
    ).rejects.toThrow(DemoIsolationError);
    expect(store.query).not.toHaveBeenCalled();
  });
  it.each([other, "22000000-0000-4000-8000-000000000001", undefined])(
    "7270/outro/sem canal é negado: %s",
    async (channelId) => {
      const store = db();
      await expect(
        assertDemoInbound(store, binding, { ...input, channelId } as never),
      ).rejects.toThrow();
      expect(store.query).not.toHaveBeenCalled();
    },
  );
  it.each([
    { safe: false },
    { safe: null },
    { latest_inbound_id: other },
    { latest_body: null },
    { latest_body: "STOP" },
    { latest_body: "me deixa em paz" },
    { recipient: null },
    { metadata: { ai_gate: "off" } },
  ])("human takeover/blocked/opt-out/incerteza veto %j", async (over) => {
    await expect(assertDemoInbound(db(over), binding, input)).rejects.toThrow();
  });
  it("erro de DB nunca alcança a ação", async () => {
    const sent = vi.fn();
    await expect(
      withDemoInbound(
        { query: vi.fn().mockRejectedValue(new Error("db unavailable")) } as never,
        binding,
        job,
        sent,
      ),
    ).rejects.toThrow();
    expect(sent).not.toHaveBeenCalled();
  });
  it("sem contexto inbound todos os envios automáticos são negados", async () => {
    enable();
    await expect(assertDemoOutbound(org, conv)).rejects.toThrow();
    await expect(
      assertDemoTransport({
        organizationId: org,
        sessionRef: "123",
        to: "15555550111",
        kind: "text",
      }),
    ).rejects.toThrow();
    expect(denyDemoAutomation).toThrow();
  });
  it("payload forjado, kind e fonte sem inbound não entram", async () => {
    for (const invalid of [
      { ...job, kind: "followup_turn" },
      { ...job, source_event_id: null },
      { ...job, payload: { ...job.payload, contact_id: other } },
    ]) {
      await expect(withDemoInbound(db(), binding, invalid as JobRow, vi.fn())).rejects.toThrow();
    }
  });
  it("mudança de estado depois do início veta o transporte", async () => {
    enable();
    const store = db();
    await withDemoInbound(store, binding, job, async () => {
      vi.mocked(store.query).mockResolvedValue({ rows: [{ ...row, safe: false }] } as never);
      await expect(assertDemoOutbound(org, conv, job.id)).rejects.toThrow();
    });
  });
  it.each([
    {
      organizationId: other,
      sessionRef: row.meta_phone_number_id,
      to: "15555550111",
      kind: "text",
    },
    { organizationId: org, sessionRef: "another-channel", to: "15555550111", kind: "text" },
    { organizationId: org, sessionRef: row.meta_phone_number_id, to: "15555557270", kind: "text" },
    {
      organizationId: org,
      sessionRef: row.meta_phone_number_id,
      to: "15555550111",
      kind: "template",
    },
  ])("nenhum envio cruza a fronteira do transporte: %j", async (envelope) => {
    enable();
    await withDemoInbound(db(), binding, job, async () => {
      await expect(assertDemoTransport(envelope)).rejects.toThrow();
    });
  });
  it("corte before-send exige o job/canal/contato exatos", async () => {
    enable();
    await withDemoInbound(db(), binding, job, async () => {
      for (const over of [
        { jobId: undefined },
        { jobId: other },
        { leadId: other },
        { channelSessionId: other },
      ]) {
        await expect(
          assertDemoBeforeSend({
            tenantId: org,
            leadId: contact,
            channelSessionId: channel,
            jobId: job.id,
            ...over,
          }),
        ).rejects.toThrow();
      }
    });
  });
  it("erro de DB no último corte também impede o envio", async () => {
    enable();
    const store = db();
    await withDemoInbound(store, binding, job, async () => {
      vi.mocked(store.query).mockRejectedValue(new Error("db unavailable"));
      await expect(
        assertDemoTransport({
          organizationId: org,
          sessionRef: row.meta_phone_number_id,
          to: "15555550111",
          kind: "text",
        }),
      ).rejects.toThrow();
    });
  });
  it.each([
    { status: "done" },
    { locked_by: "another-worker" },
    { claim_acquired_at: "another-lease" },
  ])("lease alterado veta saída: %j", async (over) => {
    enable();
    await withDemoInbound(db({}, { ...job, ...over } as JobRow), binding, job, async () => {
      await expect(assertDemoOutbound(org, conv, job.id)).rejects.toThrow();
    });
  });
  it("normal preserva as saídas sem consultar DB/contexto de demo", async () => {
    vi.stubEnv("DEMO_INBOUND_ONLY", "false");
    await expect(assertDemoOutbound(org, conv)).resolves.toBeUndefined();
    await expect(
      assertDemoTransport({ organizationId: org, sessionRef: "any", to: "any", kind: "template" }),
    ).resolves.toBeUndefined();
    expect(denyDemoAutomation).not.toThrow();
  });
});

it("binding ativado é imutável e exige o tenant/canal exatos mesmo sem env", async () => {
  vi.resetModules();
  const isolated = await import("@/lib/channels/demo-inbound-only");
  isolated.activateDemoWorker(binding);
  expect(isolated.demoInboundOnly()).toBe(true);
  expect(() => isolated.assertDemoClaimBinding()).toThrow();
  expect(() => isolated.assertDemoClaimBinding({ ...binding, organizationId: other })).toThrow();
  expect(() => isolated.assertDemoClaimBinding({ ...binding, channelId: other })).toThrow();
  expect(() => isolated.assertDemoClaimBinding(binding)).not.toThrow();
  await expect(isolated.assertDemoOutbound(org, conv)).rejects.toThrow();
  expect(() => isolated.activateDemoWorker(binding)).toThrow();
  vi.resetModules();
});
