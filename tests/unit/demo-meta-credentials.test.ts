import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_WEB_CHANNEL } from "@/lib/channels/demo-web-ingress";

const f = vi.hoisted(() => ({ read: vi.fn(), decrypt: vi.fn(), eq: vi.fn(), from: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: f.from }),
}));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: f.decrypt }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
import { appDaMeta, invalidarAppDaMeta } from "@/lib/channels/meta/app";

const row = {
  id: 1,
  app_secret_encrypted: "cipher-secret",
  verify_token_encrypted: "cipher-token",
};
beforeEach(() => {
  vi.stubEnv("DEMO_WEB_INGRESS_ONLY", "true");
  vi.stubEnv("DEMO_WEB_CHANNEL_ID", DEMO_WEB_CHANNEL);
  vi.stubEnv("DEMO_INBOUND_ONLY", "false");
  vi.stubEnv("META_APP_SECRET", "unit-env-secret");
  vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "unit-env-token");
  invalidarAppDaMeta();
  vi.clearAllMocks();
  f.read.mockReset().mockResolvedValue({ data: [row], error: null });
  f.decrypt
    .mockReset()
    .mockImplementation(async (_admin: unknown, cipher: string) =>
      cipher === "cipher-secret" ? "unit-db-secret" : "unit-db-token",
    );
  f.eq.mockImplementation(() => ({ limit: f.read, maybeSingle: f.read }));
  f.from.mockImplementation(() => ({ select: () => ({ eq: f.eq }) }));
});
afterEach(() => {
  invalidarAppDaMeta();
  vi.unstubAllEnvs();
});

describe("demo Meta credentials fail closed without cache or environment fallback", () => {
  it("resolves only the complete trusted installation singleton", async () => {
    await expect(appDaMeta()).resolves.toEqual({
      appSecret: "unit-db-secret",
      verifyToken: "unit-db-token",
    });
    expect(f.from).toHaveBeenCalledWith("platform_meta_app");
    expect(f.eq).toHaveBeenCalledWith("id", 1);
    expect(f.read).toHaveBeenCalledWith(2);
  });
  it.each([
    { data: null, error: { code: "42P01" } },
    { data: [], error: null },
    { data: [row, row], error: null },
    { data: [{ ...row, id: 2 }], error: null },
    { data: [{ ...row, app_secret_encrypted: null }], error: null },
    { data: [{ ...row, verify_token_encrypted: " " }], error: null },
    { data: [{ ...row, app_secret_encrypted: 123 }], error: null },
  ])("denies missing, ambiguous, wrong or incomplete database credentials %#", async (result) => {
    f.read.mockResolvedValue(result);
    await expect(appDaMeta()).rejects.toThrow("demo_web_ingress_denied");
    expect(f.decrypt).not.toHaveBeenCalled();
  });
  it("sanitizes thrown query errors", async () => {
    f.read.mockRejectedValue(new Error("unit-private-detail"));
    await expect(appDaMeta()).rejects.toThrow(/^demo_web_ingress_denied$/);
  });
  it.each([null, " ", 123])("denies invalid decrypted credentials %#", async (value) => {
    f.decrypt.mockResolvedValueOnce(value);
    await expect(appDaMeta()).rejects.toThrow("demo_web_ingress_denied");
  });
  it("sanitizes thrown decryption errors", async () => {
    f.decrypt.mockRejectedValue(new Error("unit-private-detail"));
    await expect(appDaMeta()).rejects.toThrow(/^demo_web_ingress_denied$/);
  });
  it("does not use a previously cached non-demo environment pair", async () => {
    vi.stubEnv("DEMO_WEB_INGRESS_ONLY", "false");
    f.read.mockResolvedValue({ data: null, error: null });
    await expect(appDaMeta()).resolves.toEqual({
      appSecret: "unit-env-secret",
      verifyToken: "unit-env-token",
    });
    vi.stubEnv("DEMO_WEB_INGRESS_ONLY", "true");
    await expect(appDaMeta()).rejects.toThrow("demo_web_ingress_denied");
    expect(f.read).toHaveBeenCalledTimes(2);
  });
  it("rechecks database availability even after strict success", async () => {
    await appDaMeta();
    f.read.mockResolvedValue({ data: null, error: { code: "unit-error" } });
    await expect(appDaMeta()).rejects.toThrow("demo_web_ingress_denied");
  });
  it("denies invalid demo configuration before credential lookup", async () => {
    vi.stubEnv("DEMO_WEB_CHANNEL_ID", "df10c6c2");
    await expect(appDaMeta()).rejects.toThrow("demo_web_ingress_denied");
    expect(f.read).not.toHaveBeenCalled();
  });
});
