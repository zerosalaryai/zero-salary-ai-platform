import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  DEMO_WEB_CHANNEL,
  readDemoWebConfig,
  demoWebRequestAllowed,
  denyDemoWebAction,
} from "@/lib/channels/demo-web-ingress";
import {
  bindDemoWebToken,
  withDemoWebInbound,
  dispatchDemoWebInbound,
  assertDemoWebIngest,
} from "@/lib/channels/demo-web-binding";
import type { InboundMessageEvent } from "@/lib/channels/meta/webhook";
const org = "10000000-0000-4000-8000-000000000001";
const binding = {
  id: DEMO_WEB_CHANNEL,
  organization_id: org,
  meta_waba_id: "111",
  meta_phone_number_id: "222",
  started_at: "2026-10-10T00:00:00Z",
};
const event: InboundMessageEvent = {
  kind: "inbound_message",
  wabaId: "111",
  phoneNumberId: "222",
  externalId: "test-wamid",
  from: "15555550101",
  profileName: null,
  sentAt: new Date("2026-10-10T01:00:00Z"),
  type: "text",
  text: "Hello",
  media: null,
};
const input = {
  organizationId: org,
  channelSessionId: DEMO_WEB_CHANNEL,
  conversationId: "20000000-0000-4000-8000-000000000002",
  contactId: "30000000-0000-4000-8000-000000000003",
  messageId: "40000000-0000-4000-8000-000000000004",
  texto: "Hello",
  nomeDoContato: null,
  origem: "meta_webhook",
};
beforeEach(() => {
  vi.stubEnv("DEMO_WEB_INGRESS_ONLY", "true");
  vi.stubEnv("DEMO_WEB_CHANNEL_ID", DEMO_WEB_CHANNEL);
  vi.stubEnv("DEMO_INBOUND_ONLY", "false");
});
afterEach(() => vi.unstubAllEnvs());
describe("web demo policy", () => {
  it("requires the exact full configured UUID", () => expect(readDemoWebConfig()).toBe(true));
  it.each([
    undefined,
    "",
    "c67e9f8a",
    "df10c6c2-0000-4000-8000-000000000001",
    "c67e9f8a-0000-4000-8000-000000000001",
  ])("rejects binding %s", (id) =>
    expect(() =>
      readDemoWebConfig({ DEMO_WEB_INGRESS_ONLY: "true", DEMO_WEB_CHANNEL_ID: id }),
    ).toThrow(),
  );
  it("rejects simultaneous worker mode", () =>
    expect(() =>
      readDemoWebConfig({
        DEMO_WEB_INGRESS_ONLY: "true",
        DEMO_WEB_CHANNEL_ID: DEMO_WEB_CHANNEL,
        DEMO_INBOUND_ONLY: "true",
      }),
    ).toThrow());
  it.each(["TRUE", "1", "unknown"])("rejects mode %s", (mode) =>
    expect(() => readDemoWebConfig({ DEMO_WEB_INGRESS_ONLY: mode })).toThrow(),
  );
  it.each([
    ["/api/v1/cron/event-log-drain", "GET"],
    ["/api/v1/system/relogio/tick", "POST"],
    ["/api/v1/webhooks/waha/token", "POST"],
    ["/api/v1/messages", "POST"],
    ["/api/v1/messages.js", "GET"],
    ["/app/inbox", "POST"],
    ["/auth/confirm", "GET"],
  ])("denies %s %s", (p, m) => expect(demoWebRequestAllowed(p, m, false)).toBe(false));
  it("allows exact Meta route and explicit login endpoint", () => {
    expect(demoWebRequestAllowed("/api/v1/webhooks/meta/token", "POST", false)).toBe(true);
    expect(demoWebRequestAllowed("/api/demo-web-auth", "POST", false)).toBe(true);
  });
  it("denies action-header spoofing on permitted paths", () => {
    expect(demoWebRequestAllowed("/api/demo-web-auth", "POST", true)).toBe(false);
    expect(demoWebRequestAllowed("/api/v1/webhooks/meta/token", "POST", true)).toBe(false);
  });
  it("normal mode remains unchanged", () => {
    vi.stubEnv("DEMO_WEB_INGRESS_ONLY", "false");
    expect(() => denyDemoWebAction()).not.toThrow();
    expect(demoWebRequestAllowed("/api/v1/messages", "POST", true)).toBe(true);
  });
});
describe("trusted web binding", () => {
  it("binds token and full UUID with strict SQL and no fallback", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [binding] });
    await bindDemoWebToken("token", { query });
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[1]).toEqual([DEMO_WEB_CHANNEL, "token"]);
    expect(query.mock.calls[0]?.[0]).toContain("not exists");
  });
  it.each(
    [[], [binding, binding], [{ ...binding, id: "other" }], [{ ...binding, meta_waba_id: "" }]].map(
      (rows) => ({ rows }),
    ),
  )("denies missing/ambiguous binding", async ({ rows }) => {
    await expect(
      bindDemoWebToken("token", { query: vi.fn().mockResolvedValue({ rows }) }),
    ).rejects.toThrow();
  });
  it("denies database lookup failure", async () => {
    await expect(
      bindDemoWebToken("token", { query: vi.fn().mockRejectedValue(Error("db")) }),
    ).rejects.toThrow();
  });
  it.each([
    { ...event, wabaId: "other" },
    { ...event, phoneNumberId: "other" },
  ])("denies transport mismatch before action", async (e) => {
    const action = vi.fn();
    await expect(
      withDemoWebInbound({ binding, db: { query: vi.fn() } }, e, action),
    ).rejects.toThrow();
    expect(action).not.toHaveBeenCalled();
  });
  it("denies tenant mismatch and missing context", async () => {
    expect(() => assertDemoWebIngest(org, event)).toThrow();
    await withDemoWebInbound({ binding, db: { query: vi.fn() } }, event, async () => {
      expect(() => assertDemoWebIngest("other", event)).toThrow();
      expect(() => assertDemoWebIngest(org, event, "other")).toThrow();
    });
  });
  it("refuses the obsolete split dispatch path without any database mutation", async () => {
    const query = vi.fn();
    await expect(
      withDemoWebInbound({ binding, db: { query } }, event, () => dispatchDemoWebInbound(input)),
    ).rejects.toThrow("demo_web_ingress_denied");
    expect(query).not.toHaveBeenCalled();
  });
});
