import { NextRequest } from "next/server";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { DEMO_WEB_CHANNEL } from "@/lib/channels/demo-web-ingress";
const mocks = vi.hoisted(() => ({ login: vi.fn(), mfa: vi.fn(), renew: vi.fn() }));
vi.mock("@/app/actions/auth/signInWithPassword", () => ({ signInWithPassword: mocks.login }));
vi.mock("@/app/actions/auth/verifyMfa", () => ({ verifyMfa: mocks.mfa }));
vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: unknown,
    _key: unknown,
    options: { cookies: { setAll: (v: unknown[]) => void } },
  ) => ({
    auth: {
      getUser: async () => {
        options.cookies.setAll([
          { name: "test-session", value: "renewed", options: { httpOnly: true } },
        ]);
        mocks.renew();
        return { data: { user: { id: "unit-user" } } };
      },
    },
    rpc: vi.fn(),
  }),
}));
import { proxy } from "@/proxy";
import { POST as auth } from "@/app/api/demo-web-auth/route";
import { drainEventLog } from "@/lib/event-log/drain";
import { executarTickDoRelogio } from "@/lib/relogio/executar";
import { runFollowupTick, avancarEnrollmentAtivo } from "@/lib/followup/engine";
import { enviarTextoFixoPendente } from "@/lib/followup/enviar-texto-fixo";
import { acelerarPipelineDeEventos, kickLocalPipeline } from "@/lib/dev/kick-local-pipeline";
import { runAutomationForEvent } from "@/lib/automation/engine";
import { tickCron } from "@/lib/agent-engine/cron/scheduler";
import { metaCloudAdapter } from "@/lib/channels/adapters/meta-cloud";
import { wahaAdapter } from "@/lib/channels/adapters/waha";
import { zernioAdapter } from "@/lib/channels/adapters/zernio";
import { sendTemplate } from "@/lib/channels/meta/send-template";
import { WahaClient } from "@/lib/waha/client";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { claimJobs } from "@/lib/agent-engine/queue/queue";
import { drainTick } from "@/lib/agent-engine/edge/crm/drain";
beforeEach(() => {
  vi.stubEnv("DEMO_WEB_INGRESS_ONLY", "true");
  vi.stubEnv("DEMO_WEB_CHANNEL_ID", DEMO_WEB_CHANNEL);
  vi.stubEnv("DEMO_INBOUND_ONLY", "false");
  mocks.login.mockReset();
  mocks.mfa.mockReset();
  mocks.renew.mockReset();
});
afterEach(() => vi.unstubAllEnvs());
it.each([
  "/api/v1/cron/event-log-drain",
  "/api/v1/system/relogio/tick",
  "/api/v1/messages.js",
  "/api/v1/webhooks/waha/token",
])("proxy denies GET before public bypass: %s", async (path) => {
  expect((await proxy(new NextRequest("https://demo.invalid" + path))).status).toBe(403);
  expect(mocks.renew).not.toHaveBeenCalled();
});
it("proxy allows Meta webhook POST while denying action spoofing", async () => {
  const url = "https://demo.invalid/api/v1/webhooks/meta/token";
  expect((await proxy(new NextRequest(url, { method: "POST" }))).status).toBe(200);
  expect(
    (await proxy(new NextRequest(url, { method: "POST", headers: { "next-action": "spoof" } })))
      .status,
  ).toBe(403);
});
it("proxy denies native form POST and preserves UI cookie renewal", async () => {
  expect(
    (await proxy(new NextRequest("https://demo.invalid/app/inbox", { method: "POST" }))).status,
  ).toBe(403);
  const response = await proxy(new NextRequest("https://demo.invalid/app/inbox"));
  expect(response.cookies.get("test-session")?.value).toBe("renewed");
  expect(response.headers.get("Content-Security-Policy")).toBe("connect-src 'self'; form-action 'self'");
  expect(mocks.renew).toHaveBeenCalledOnce();
});
it("password login uses explicit validated endpoint", async () => {
  mocks.login.mockResolvedValue({ ok: false, error: "invalid_credentials" });
  const response = await auth(
    new NextRequest("https://demo.invalid/api/demo-web-auth", {
      method: "POST",
      headers: { origin: "https://demo.invalid", "content-type": "application/json" },
      body: JSON.stringify({
        kind: "login",
        credentials: { email: "unit@example.invalid", password: "unit-password" },
      }),
    }),
  );
  expect(response.status).toBe(200);
  expect(mocks.login).toHaveBeenCalledOnce();
});
it("TOTP keeps the existing verifier", async () => {
  mocks.mfa.mockResolvedValue({ ok: false, error: "mfa_invalid" });
  const response = await auth(
    new NextRequest("https://demo.invalid/api/demo-web-auth", {
      method: "POST",
      headers: { origin: "https://demo.invalid", "content-type": "application/json" },
      body: JSON.stringify({ kind: "totp", code: "123456" }),
    }),
  );
  expect(response.status).toBe(200);
  expect(mocks.mfa).toHaveBeenCalledWith("123456", undefined);
});
it("auth refuses foreign origin, action header and unknown auth operation", async () => {
  for (const [origin, action, body] of [
    ["https://other.invalid", "", JSON.stringify({ kind: "totp", code: "123456" })],
    ["https://demo.invalid", "spoof", JSON.stringify({ kind: "totp", code: "123456" })],
    ["https://demo.invalid", "", JSON.stringify({ kind: "signup" })],
  ]) {
    const response = await auth(
      new NextRequest("https://demo.invalid/api/demo-web-auth", {
        method: "POST",
        headers: { origin: origin!, "next-action": action!, "content-type": "application/json" },
        body,
      }),
    );
    expect(response.status).toBeGreaterThanOrEqual(400);
  }
  expect(mocks.login).not.toHaveBeenCalled();
  expect(mocks.mfa).not.toHaveBeenCalled();
});
it.each([
  ["event replay", () => drainEventLog({} as never)],
  ["system tick", () => executarTickDoRelogio()],
  ["followups", () => runFollowupTick({} as never)],
  ["direct enrollment", () => avancarEnrollmentAtivo({} as never, {} as never)],
  ["fixed text", () => enviarTextoFixoPendente({} as never)],
  ["acceleration", () => acelerarPipelineDeEventos({} as never)],
  ["kick", () => kickLocalPipeline({} as never)],
  ["automation", () => runAutomationForEvent({} as never, {} as never)],
  ["cron", () => tickCron({} as never, {} as never, {} as never)],
  ["claim", () => claimJobs({} as never, {} as never)],
  ["inbound drain", () => drainTick({} as never, {} as never, {} as never)],
  ["manual send", () => sendMessageHandler({} as never, {} as never, {} as never)],
  ["Meta adapter", () => metaCloudAdapter.send({} as never)],
  ["WAHA adapter", () => wahaAdapter.send({} as never)],
  ["Zernio adapter", () => zernioAdapter.send({} as never)],
  ["raw template", () => sendTemplate({} as never)],
  [
    "raw WAHA",
    () =>
      new WahaClient("https://unit.invalid", "unit-key").sendMessage(
        "unit-session",
        "unit-chat",
        "hello",
      ),
  ],
] as const)("domain denial before effects: %s", async (_name, action) => {
  await expect(action()).rejects.toThrow("demo_web_ingress_denied");
});
