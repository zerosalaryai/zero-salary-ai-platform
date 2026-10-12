import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_WEB_CHANNEL } from "@/lib/channels/demo-web-ingress";
import type { ActionCtx } from "@/lib/automation/types";

const effects = vi.hoisted(() => ({
  admin: vi.fn(),
  send: vi.fn(),
  generate: vi.fn(),
  pool: vi.fn(),
  service: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: effects.admin }));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: effects.send }));
vi.mock("@/lib/agent-engine/agent/abordagem-de-formulario", () => ({
  gerarAbordagemDeFormulario: effects.generate,
}));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool: effects.pool }));
vi.mock("@/lib/atendimento/origem-automacao", () => ({ serviceForAutomation: effects.service }));
vi.mock("@/lib/env", () => ({ env: { INTERNAL_CRON_SECRET: "synthetic-cron-secret" } }));

import { getAction } from "@/lib/automation/actions";
import "@/lib/automation/actions/send-ai-message";
import "@/lib/automation/actions/send-whatsapp";
import { GET, POST } from "@/app/api/v1/cron/agenda-reminder/route";
import {
  cancelPendingCronsForLead,
  runCronLoop,
  scheduleCronJob,
  tickCron,
} from "@/lib/agent-engine/cron/scheduler";

const org = "11000000-0000-4000-8000-000000000003";
const contact = "11000000-0000-4000-8000-000000000005";
function mode(kind: "web" | "worker") {
  vi.stubEnv("DEMO_WEB_INGRESS_ONLY", kind === "web" ? "true" : "false");
  vi.stubEnv("DEMO_WEB_CHANNEL_ID", DEMO_WEB_CHANNEL);
  vi.stubEnv("DEMO_INBOUND_ONLY", kind === "worker" ? "true" : "false");
  vi.stubEnv("DEMO_CHANNEL_ID", DEMO_WEB_CHANNEL);
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("DEMO_WEB_INGRESS_ONLY", "false");
  vi.stubEnv("DEMO_INBOUND_ONLY", "false");
});
afterEach(() => vi.unstubAllEnvs());

describe.each(["web", "worker"] as const)("independent senders in %s demo process", (kind) => {
  it.each(["send_ai_message", "send_whatsapp_message"])(
    "%s denies execution and postponement before side effects",
    async (type) => {
      mode(kind);
      const from = vi.fn(() => {
        throw new Error("unexpected database access");
      });
      const ctx = { admin: { from }, organizationId: org, context: {} } as unknown as ActionCtx;
      const action = getAction(type)!;
      for (const channel of [DEMO_WEB_CHANNEL, "df10c6c2-0000-4000-8000-000000000002"]) {
        const config = {
          channel_session_id: channel,
          agent_id: contact,
          instruction: "Synthetic",
          template: "Synthetic",
        };
        await expect(action.execute(ctx, config)).rejects.toThrow(/demo_.*denied/);
        await expect(action.postponeUntil!(ctx, config)).rejects.toThrow(/demo_.*denied/);
      }
      expect(from).not.toHaveBeenCalled();
      for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
    },
  );
  it.each([GET, POST])(
    "reminder handler denies direct invocation before admin/conversation/send",
    async (handler) => {
      mode(kind);
      const response = await handler(
        new NextRequest("https://demo.invalid/api/v1/cron/agenda-reminder", {
          method: handler === POST ? "POST" : "GET",
          headers: { authorization: "Bearer synthetic-cron-secret" },
        }),
      );
      expect(response.status).toBe(403);
      for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
    },
  );
  it("direct schedule, tick and loop cannot create or claim cron work", async () => {
    mode(kind);
    const pool = { query: vi.fn(), connect: vi.fn() };
    const signal = new AbortController().signal;
    await expect(scheduleCronJob(pool as never, org, {} as never)).rejects.toThrow(/demo_.*denied/);
    await expect(tickCron(pool as never, { batchSize: 1 } as never, {} as never)).rejects.toThrow(
      /demo_.*denied/,
    );
    await expect(runCronLoop(pool as never, {} as never, {} as never, signal)).rejects.toThrow(
      /demo_.*denied/,
    );
    expect(pool.query).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

it("invalid demo configuration denies reminder without any database access", async () => {
  vi.stubEnv("DEMO_INBOUND_ONLY", "unknown");
  expect(
    (await GET(new NextRequest("https://demo.invalid/api/v1/cron/agenda-reminder"))).status,
  ).toBe(403);
  expect(effects.admin).not.toHaveBeenCalled();
});
it("normal actions keep existing configuration failure results", async () => {
  for (const type of ["send_ai_message", "send_whatsapp_message"]) {
    expect(await getAction(type)!.execute({} as never, {})).toEqual({
      type,
      status: "failed",
      error: "missing_config",
    });
  }
});
it("normal reminder retains authenticated empty scan and rejects wrong secret", async () => {
  const request = (secret: string) =>
    new NextRequest("https://demo.invalid/api/v1/cron/agenda-reminder", {
      headers: { authorization: `Bearer ${secret}` },
    });
  expect((await GET(request("invalid"))).status).toBe(403);
  expect(effects.admin).not.toHaveBeenCalled();
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "not", "gt", "lte", "order"])
    chain[method] = vi.fn(() => chain);
  chain.limit = vi.fn(async () => ({ data: [], error: null }));
  const from = vi.fn(() => chain);
  effects.admin.mockReturnValue({ from });
  expect((await GET(request("synthetic-cron-secret"))).status).toBe(200);
  expect(from).toHaveBeenCalledWith("calendar_appointments");
  expect(effects.send).not.toHaveBeenCalled();
});
it("normal scheduler entrypoints remain usable", async () => {
  const pool = { query: vi.fn(), connect: vi.fn() };
  expect(await tickCron(pool as never, { batchSize: 0 } as never, {} as never)).toEqual({
    fired: 0,
    retried: 0,
    disabled: 0,
  });
  const controller = new AbortController();
  controller.abort();
  await expect(
    runCronLoop(pool as never, {} as never, {} as never, controller.signal),
  ).resolves.toBeUndefined();
});
it("opt-out can still cancel scoped crons in worker demo mode", async () => {
  mode("worker");
  const query = vi.fn(async () => ({ rowCount: 1 }));
  expect(await cancelPendingCronsForLead({ query } as never, org, contact)).toBe(1);
  expect(query).toHaveBeenCalledWith(
    expect.stringContaining("where organization_id = $1 and contact_id = $2"),
    [org, contact],
  );
});
