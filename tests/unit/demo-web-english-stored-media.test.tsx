import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/v1/messages/[id]/media/route";
import { DEMO_WEB_CHANNEL, demoWebRequestAllowed } from "@/lib/channels/demo-web-ingress";
const f = vi.hoisted(() => ({ authenticated: true, denied: false, support: false, error: "", rows: {} as Record<string, Record<string, unknown>>, queries: [] as Array<{table: string; filters: Array<[string, unknown]>}>, download: vi.fn(), sessionDownload: vi.fn(), sign: vi.fn(), transport: vi.fn(), admin: vi.fn() }));
const org = "10000000-0000-4000-8000-000000000001", id = "20000000-0000-4000-8000-000000000001", conversation = "30000000-0000-4000-8000-000000000001", contact = "40000000-0000-4000-8000-000000000001";
const client = { auth: { getUser: async () => ({data: {user: f.authenticated ? {id: "viewer"} : null}}) }, from: (table: string) => {
  const filters: Array<[string, unknown]> = []; f.queries.push({table, filters});
  const q = {select: () => q, eq: (k: string, v: unknown) => {filters.push([k,v]);return q;}, is: (k: string, v: unknown) => {filters.push([k,v]);return q;}, maybeSingle: async () => ({data: filters.every(([k,v]) => f.rows[table]?.[k] === v) ? f.rows[table] : null, error: f.error === table ? {} : null})}; return q;
}, storage: {from: () => ({download: f.sessionDownload})} };
vi.mock("@/lib/supabase/server", () => ({createClient: async () => client}));
vi.mock("@/lib/supabase/admin", () => ({createAdminClient: f.admin}));
vi.mock("@/lib/channels", () => ({ getAdapter: f.transport }));
vi.mock("@/lib/auth/server", () => ({loadAuthUser: async () => ({id: "viewer", idioma: "en-US", support: f.support}), resolveActiveOrg: async () => ({orgId: org})}));
vi.mock("@/lib/auth/require-role", () => ({requireRole: async () => ({ok: !f.denied, user: {id: "viewer"}, org: {orgId: org}})}));
async function request(messageId = id) { return GET(new NextRequest(`http://localhost/api/v1/messages/${messageId}/media`), {params: Promise.resolve({id: messageId})}); }
beforeEach(() => {
  vi.stubEnv("DEMO_WEB_INGRESS_ONLY", "true"); vi.stubEnv("DEMO_WEB_CHANNEL_ID", DEMO_WEB_CHANNEL);
  f.authenticated = true; f.denied = false; f.support = false; f.error = ""; f.queries = []; vi.clearAllMocks();
  f.rows = {
    channel_sessions: {id: DEMO_WEB_CHANNEL, organization_id: org, archived_at: null},
    messages: {id, organization_id: org, channel_session_id: DEMO_WEB_CHANNEL, conversation_id: conversation, contact_id: contact, media_storage_path: `${org}/${conversation}/${id}.png`, media_mime: "image/png", media_size_bytes: 3},
    conversations: {id: conversation, organization_id: org, channel_session_id: DEMO_WEB_CHANNEL, contact_id: contact}, contacts: {id: contact, organization_id: org},
  };
  f.sessionDownload.mockResolvedValue({data: null, error: {message: "private bucket denies session access"}});
  f.admin.mockImplementation(() => {
    // Construct privileged storage only AFTER all session-scoped binding checks.
    expect(f.queries.map(q => q.table)).toEqual(["channel_sessions", "messages", "conversations", "contacts"]);
    for (const q of f.queries) expect(q.filters).toContainEqual(["organization_id", org]);
    return {storage: {from: (bucket: string) => {
      expect(bucket).toBe("whatsapp-media");
      return {download: f.download, createSignedUrl: f.sign};
    }}};
  });
  f.download.mockResolvedValue({data: new Blob(["abc"], {type: "image/png"}), error: null});
});
afterEach(() => { expect(f.transport).not.toHaveBeenCalled(); expect(f.sessionDownload).not.toHaveBeenCalled(); expect(f.sign).not.toHaveBeenCalled(); vi.unstubAllEnvs(); });
describe("demo stored media authorization", () => {
  it("serves authorized stored media through privileged private storage without redirect or transport", async () => {
    const response = await request(); expect(response.status).toBe(200); expect(await response.text()).toBe("abc");
    expect(response.headers.get("location")).toBeNull(); expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(f.admin).toHaveBeenCalledOnce();
    expect(f.download).toHaveBeenCalledWith(`${org}/${conversation}/${id}.png`);
    for (const q of f.queries) expect(q.filters).toContainEqual(["organization_id", org]);
  });
  it("serves canonical stored OGG/Opus despite session Storage denial", async () => {
    const bytes = new TextEncoder().encode("OggSsyntheticOpusHead");
    Object.assign(f.rows.messages!, {
      media_storage_path: `${org}/${conversation}/${id}.ogg`,
      media_mime: "audio/ogg;codecs=opus", media_size_bytes: bytes.byteLength,
    });
    f.download.mockResolvedValue({data: new Blob([bytes], {type: "audio/ogg;codecs=opus"}), error: null});
    const response = await request();
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get("content-type")).toBe("audio/ogg");
    expect(response.headers.get("content-disposition")).toBe("inline");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(response.headers.get("location")).toBeNull();
    expect(f.admin).toHaveBeenCalledOnce();
    expect(f.download).toHaveBeenCalledExactlyOnceWith(`${org}/${conversation}/${id}.ogg`);
  });
  it.each([`foreign/${id}.ogg`, `${org}/foreign/${id}.ogg`, `${org}/${conversation}/foreign.ogg`,
    `${org}/${conversation}/../${id}.ogg`, `https://storage.invalid/${id}.ogg`])("denies noncanonical path %s before privileged storage", async path => {
    f.rows.messages!.media_mime="audio/ogg"; f.rows.messages!.media_storage_path=path;
    expect((await request()).status).toBe(404);
    expect(f.admin).not.toHaveBeenCalled(); expect(f.download).not.toHaveBeenCalled();
  });
  it.each(["messages", "conversations", "contacts", "channel_sessions"])("denies foreign tenant at %s", async table => {
    f.rows[table]!.organization_id = "foreign"; expect((await request()).status).not.toBe(200); expect(f.download).not.toHaveBeenCalled(); expect(f.admin).not.toHaveBeenCalled();
  });
  it.each(["messages", "conversations", "channel_sessions"])("denies 7270 binding at %s", async table => {
    if (table === "channel_sessions") f.rows[table]!.id = "df10c6c2-d728-47a4-8995-240fba6d4799";
    else f.rows[table]!.channel_session_id = "df10c6c2-d728-47a4-8995-240fba6d4799";
    expect((await request()).status).not.toBe(200); expect(f.download).not.toHaveBeenCalled(); expect(f.admin).not.toHaveBeenCalled();
  });
  it.each(["messages", "conversations", "contacts", "channel_sessions"])("fails closed on %s lookup error", async table => {
    f.error = table; expect((await request()).status).not.toBe(200); expect(f.download).not.toHaveBeenCalled(); expect(f.admin).not.toHaveBeenCalled();
  });
  it.each(["anonymous", "role", "support", "invalid-id", "missing-media", "revoked", "foreign-path", "oversize", "wrong-contact"])("denies %s", async kind => {
    if (kind === "anonymous") f.authenticated = false;
    if (kind === "role") f.denied = true;
    if (kind === "support") f.support = true;
    if (kind === "missing-media") f.rows.messages!.media_storage_path = null;
    if (kind === "revoked") f.rows.messages!.revoked_at = "2026-10-13";
    if (kind === "foreign-path") f.rows.messages!.media_storage_path = `foreign/${id}.png`;
    if (kind === "oversize") f.rows.messages!.media_size_bytes = 26 * 1024 * 1024;
    if (kind === "wrong-contact") f.rows.conversations!.contact_id = "foreign";
    expect((await request(kind === "invalid-id" ? "invalid" : id)).status).not.toBe(200); expect(f.download).not.toHaveBeenCalled(); expect(f.admin).not.toHaveBeenCalled();
  });
  it("fails closed on Storage denial", async () => { f.download.mockResolvedValue({error: {}}); expect((await request()).status).toBe(404); });
  it("never serves size-mismatched objects", async () => { f.rows.messages!.media_size_bytes = 2; expect((await request()).status).toBe(404); });
  it("serves active document types as sandboxed attachments", async () => {
    f.rows.messages!.media_mime = "text/html"; f.rows.messages!.media_storage_path = `${org}/${conversation}/${id}.bin`;
    const response = await request(); expect(response.status).toBe(200); expect(response.headers.get("content-type")).toBe("application/octet-stream"); expect(response.headers.get("content-disposition")).toBe("attachment");
  });
  it("permits only exact media GET paths, preserving other demo restrictions and normal mode", () => {
    const path = `/api/v1/messages/${id}/media`;
    expect(demoWebRequestAllowed(path, "GET", false)).toBe(true);
    for (const method of ["POST", "PUT", "DELETE", "HEAD"]) expect(demoWebRequestAllowed(path, method, false)).toBe(false);
    expect(demoWebRequestAllowed(path, "GET", true)).toBe(false);
    expect(demoWebRequestAllowed("/api/v1/messages/export", "GET", false)).toBe(false);
    expect(demoWebRequestAllowed("/api/v1/contacts/x/avatar", "GET", false)).toBe(false);
    vi.stubEnv("DEMO_WEB_INGRESS_ONLY", "false"); expect(demoWebRequestAllowed(path, "POST", false)).toBe(true);
  });
});
