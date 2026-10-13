import { NextRequest } from "next/server";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { DEMO_WEB_CHANNEL } from "@/lib/channels/demo-web-ingress";
const f = vi.hoisted(() => ({ commit: vi.fn(), role: vi.fn(), client: vi.fn(), refresh: vi.fn(), user: vi.fn(), logout: vi.fn(), query: vi.fn(), factors: vi.fn(), enroll: vi.fn(), confirm: vi.fn(), login: vi.fn(), totp: vi.fn(), del: vi.fn(), audit: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: f.client, createCookieBufferedClient: async () => ({ supabase: await f.client(), commitCookies: f.commit }) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: f.role }));
vi.mock("@/app/actions/auth/enrollMfa", () => ({ enrollMfa: f.enroll }));
vi.mock("@/app/actions/auth/confirmMfaEnroll", () => ({ confirmMfaEnroll: f.confirm }));
vi.mock("@/app/actions/auth/signInWithPassword", () => ({ signInWithPassword: f.login }));
vi.mock("@/app/actions/auth/verifyMfa", () => ({ verifyMfa: f.totp }));
vi.mock("next/headers", () => ({ cookies: async () => ({ delete: f.del }) }));
vi.mock("@/lib/audit", () => ({ audit: f.audit }));
import { POST } from "@/app/api/demo-web-auth/route";
function request(body: unknown, headers: Record<string, string> = {}) {
 return new NextRequest("http://internal:3000/api/demo-web-auth", { method: "POST", headers: { origin: "https://demo.invalid", "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}
beforeEach(() => {
 vi.resetAllMocks();
 vi.stubEnv("DEMO_WEB_INGRESS_ONLY", "true"); vi.stubEnv("DEMO_WEB_CHANNEL_ID", DEMO_WEB_CHANNEL); vi.stubEnv("DEMO_INBOUND_ONLY", "false"); vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://demo.invalid");
 f.role.mockResolvedValue({ ok: true, user: { id: "viewer" }, org: { orgId: "org" } });
 f.query.mockResolvedValue({ data: { id: DEMO_WEB_CHANNEL, organization_id: "org" }, error: null });
 const q = { select: vi.fn().mockReturnThis(), eq: vi.fn().mockReturnThis(), is: vi.fn().mockReturnThis(), maybeSingle: f.query };
 f.client.mockResolvedValue({ from: vi.fn(() => q), auth: { refreshSession: f.refresh, getUser: f.user, signOut: f.logout, mfa: { listFactors: f.factors } } });
 f.refresh.mockResolvedValue({ data: { session: { synthetic: true } }, error: null });
 f.user.mockResolvedValue({ data: { user: { id: "viewer" } }, error: null }); f.logout.mockResolvedValue({ error: null });
 f.enroll.mockResolvedValue({ ok: true }); f.confirm.mockResolvedValue({ ok: true }); f.totp.mockResolvedValue({ ok: false, error: "mfa_invalid" });
});
afterEach(() => vi.unstubAllEnvs());
it("rotates via cookie-bound SSR SDK and returns no session", async () => {
 const res = await POST(request({ kind: "refresh" })); expect(res.status).toBe(200);
 expect(await res.json()).toEqual({ data: { refreshed: true } }); expect(res.headers.get("cache-control")).toBe("no-store"); expect(f.refresh).toHaveBeenCalledWith(); expect(f.commit).toHaveBeenCalledOnce(); expect(f.role).toHaveBeenCalledWith("viewer");
 const supabase = await f.client(); const q = supabase.from(); expect(q.eq).toHaveBeenCalledWith("organization_id", "org"); expect(q.eq).toHaveBeenCalledWith("id", DEMO_WEB_CHANNEL);
});
it.each([401, 403])("rejects expired/revoked/MFA-pending authorization (%s)", async status => {
 f.role.mockResolvedValue({ ok: false, response: new Response(null, { status }) }); expect((await POST(request({ kind: "refresh" }))).status).toBe(status); expect(f.refresh).not.toHaveBeenCalled();
});
it.each(["foreign-org", "7270", "missing", "error"])("rejects channel binding %s", async state => {
 f.query.mockResolvedValue({ data: state === "missing" ? null : { id: state === "7270" ? "other-channel" : DEMO_WEB_CHANNEL, organization_id: state === "foreign-org" ? "foreign" : "org" }, error: state === "error" ? {} : null });
 expect((await POST(request({ kind: "refresh" }))).status).toBe(403); expect(f.refresh).not.toHaveBeenCalled();
});
it.each(["error", "empty", "changed-user"])("fails closed on refresh %s", async state => {
 if (state !== "changed-user") f.refresh.mockResolvedValue({ data: { session: null }, error: state === "error" ? {} : null });
 else f.user.mockResolvedValue({ data: { user: { id: "foreign" } }, error: null });
 expect((await POST(request({ kind: "refresh" }))).status).toBe(401);
});
it("logs out only the caller session without requiring completed MFA", async () => {
 const res = await POST(request({ kind: "logout" })); expect(res.status).toBe(200); expect(f.logout).toHaveBeenCalledWith({ scope: "local" }); expect(f.commit).toHaveBeenCalledOnce(); expect(f.del).toHaveBeenCalledWith("active_org"); expect(f.role).not.toHaveBeenCalled(); expect(f.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "auth.logout", actorUserId: "viewer" }));
});
it("does not claim successful revocation when logout fails", async () => {
 f.logout.mockResolvedValue({ error: {} }); expect((await POST(request({ kind: "logout" }))).status).toBe(503); expect(f.commit).not.toHaveBeenCalled(); expect(f.del).not.toHaveBeenCalled(); expect(f.audit).not.toHaveBeenCalled();
});
it("rejects unauthenticated logout", async () => {
 f.user.mockResolvedValue({ data: { user: null }, error: {} }); expect((await POST(request({ kind: "logout" }))).status).toBe(401); expect(f.logout).not.toHaveBeenCalled();
});
it.each<Record<string, string>>([{ origin: "" }, { origin: "https://foreign.invalid" }, { "next-action": "action" }, { "content-type": "text/plain" }])("denies CSRF/unsupported request headers %j", async headers => {
 expect((await POST(request({ kind: "refresh" }, headers))).status).toBe(403); expect(f.client).not.toHaveBeenCalled(); expect(f.role).not.toHaveBeenCalled();
});
it.each([{kind:"refresh", refresh_token:"not-accepted"}, {kind:"delete"}, {kind:"logout", organization_id:"foreign"}])("rejects caller tokens or unsupported action fields", async body => {
 expect((await POST(request(body))).status).toBe(400); expect(f.client).not.toHaveBeenCalled();
});
it("keeps normal mode closed on the demo endpoint", async () => {
 vi.stubEnv("DEMO_WEB_INGRESS_ONLY", "false"); expect((await POST(request({ kind: "refresh" }))).status).toBe(404); expect(f.client).not.toHaveBeenCalled();
});
it("keeps existing TOTP verification action", async () => {
 expect((await POST(request({ kind: "totp", code: "123456" }))).status).toBe(200); expect(f.totp).toHaveBeenCalledWith("123456", undefined); expect(f.refresh).not.toHaveBeenCalled();
});
it("allows enrollment only behind scoped membership guard", async () => {
 expect((await POST(request({ kind: "enroll" }))).status).toBe(200); expect(f.enroll).toHaveBeenCalledOnce();
});
it("confirms only a caller-owned unverified TOTP factor", async () => {
 const id = "12345678-1234-4123-8123-123456789abc";
 f.factors.mockResolvedValue({ data: { all: [{ id, factor_type: "totp", status: "unverified" }] }, error: null });
 expect((await POST(request({kind:"confirm-enroll",code:"123456",factor_id:id}))).status).toBe(200); expect(f.confirm).toHaveBeenCalledWith("123456",id);
 f.factors.mockResolvedValue({ data: { all: [] }, error: null });
 expect((await POST(request({kind:"confirm-enroll",code:"123456",factor_id:id}))).status).toBe(403); expect(f.confirm).toHaveBeenCalledTimes(1);
});
it("rejects support sessions", async () => {
 f.role.mockResolvedValue({ok:true,user:{id:"viewer",support:{}},org:{orgId:"org"}});
 expect((await POST(request({kind:"refresh"}))).status).toBe(403); expect(f.refresh).not.toHaveBeenCalled();
});

it("does not report refresh success when cookie persistence fails", async () => {
 f.commit.mockImplementation(() => { throw new Error("synthetic cookie error"); });
 const res = await POST(request({kind:"refresh"})); expect(res.status).toBe(503);
 expect(await res.json()).toEqual({error:{code:"internal_error",message:"Authentication unavailable"}});
});
