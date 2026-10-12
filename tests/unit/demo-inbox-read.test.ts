import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import type * as ReactTypes from "react";
import { DEMO_WEB_CHANNEL, demoWebRequestAllowed } from "@/lib/channels/demo-web-ingress";

const f = vi.hoisted(() => ({
  anonymous: false,
  roleDenied: false,
  activeOrg: "10000000-0000-4000-8000-000000000001",
  errorTable: "",
  queries: [] as Array<{ table: string; filters: Array<[string, string, unknown]> }>,
  options: [] as Array<{ queryFn: (args: { pageParam?: string }) => Promise<unknown> }>,
  tables: {} as Record<string, Array<Record<string, unknown>>>,
}));
const user = { id: "90000000-0000-4000-8000-000000000009", idioma: "en-US" };
const org = "10000000-0000-4000-8000-000000000001";
const foreign = "10000000-0000-4000-8000-000000000099";
const off = "df10c6c2-0000-4000-8000-000000000001";
const conversation = "20000000-0000-4000-8000-000000000002";
const otherConversation = "20000000-0000-4000-8000-000000000003";
const foreignConversation = "20000000-0000-4000-8000-000000000099";
const contact = "30000000-0000-4000-8000-000000000003";

// Synthetic query evaluator applies the actual handler's tenant/channel predicates.
// No RLS behavior or production grants are simulated or claimed here.
function from(table: string) {
  const entry = { table, filters: [] as Array<[string, string, unknown]> };
  f.queries.push(entry);
  let maximum = Infinity;
  const result = () => {
    let data = (f.tables[table] ?? []).filter((row) =>
      entry.filters.every(([op, key, value]) => {
        if (key === "contacts.organization_id")
          return f.tables.contacts?.some((c) => c.id === row.contact_id && c.organization_id === value);
        if (op === "eq" || op === "is") return row[key] === value;
        if (op === "in") return (value as unknown[]).includes(row[key]);
        if (op === "gt") return Number(row[key]) > Number(value);
        if (op === "not")
          return !String(value).replace(/[()]/g, "").split(",").includes(String(row[key]));
        return true;
      }),
    );
    data = data.slice(0, maximum);
    return { data, error: f.errorTable === table ? { message: "synthetic lookup failure" } : null };
  };
  const query = {
    select: () => query,
    eq: (key: string, value: unknown) => {
      entry.filters.push(["eq", key, value]);
      return query;
    },
    is: (key: string, value: unknown) => {
      entry.filters.push(["is", key, value]);
      return query;
    },
    in: (key: string, value: unknown[]) => {
      entry.filters.push(["in", key, value]);
      return query;
    },
    gt: (key: string, value: unknown) => {
      entry.filters.push(["gt", key, value]);
      return query;
    },
    not: (key: string, _op: string, value: unknown) => {
      entry.filters.push(["not", key, value]);
      return query;
    },
    order: () => query,
    or: () => query,
    ilike: () => query,
    limit: (n: number) => {
      maximum = n;
      return query;
    },
    maybeSingle: async () => {
      const r = result();
      return {
        data: r.data.length === 1 ? r.data[0] : null,
        error: r.error ?? (r.data.length > 1 ? { message: "ambiguous" } : null),
      };
    },
    then: (resolve: (value: ReturnType<typeof result>) => unknown) =>
      Promise.resolve(result()).then(resolve),
  };
  return query;
}
const session = {
  from,
  auth: { getUser: async () => ({ data: { user: f.anonymous ? null : user }, error: null }) },
};
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => session }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => (f.anonymous ? null : user),
  resolveActiveOrg: async () => ({ orgId: f.activeOrg }),
}));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () =>
    f.roleDenied || f.anonymous ? { ok: false } : { ok: true, user, org: { orgId: f.activeOrg } },
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => {
    throw Error("admin access forbidden");
  },
}));
vi.mock("@/lib/audit", () => ({
  audit: () => {
    throw Error("read mutation forbidden");
  },
}));
vi.mock("@/lib/users/com-nome-do-atendente", () => ({
  comNomeDoAtendente: async (rows: unknown[]) => rows,
}));
vi.mock("@tanstack/react-query", () => ({
  useInfiniteQuery: (options: (typeof f.options)[number]) => {
    f.options.push(options);
    return {};
  },
  useQuery: (options: (typeof f.options)[number]) => {
    f.options.push(options);
    return {};
  },
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof ReactTypes>()),
  useCallback: (fn: unknown) => fn,
}));
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: () => ({ status: "CLOSED", ultimaEntrega: { current: null } }),
}));
vi.mock("@/hooks/realtime/useRefetchDeSeguranca", () => ({ useRefetchDeSeguranca: () => ({}) }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));

import { GET as list } from "@/app/api/v1/conversations/route";
import { GET as detail } from "@/app/api/v1/conversations/[id]/route";
import { GET as messages } from "@/app/api/v1/conversations/[id]/messages/route";
import {
  getConversationHandler,
  patchConversationHandler,
} from "@/app/api/v1/conversations/_handler";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import { demoInboxReadChannel } from "@/lib/channels/demo-inbox-read";
import { useConversationsRealtime } from "@/hooks/inbox/useConversationsRealtime";
import { useConversation } from "@/hooks/inbox/useConversation";
import { useMessagesRealtime } from "@/hooks/inbox/useMessagesRealtime";

const ctx: HandlerCtx = {
  organization_id: org,
  actor: { type: "user", id: user.id },
  requestId: "test",
};
const client = session as never;
function req(path: string) {
  return new NextRequest("https://demo.invalid" + path);
}
function params(id: string) {
  return { params: Promise.resolve({ id }) };
}
async function read(path: string) {
  if (!demoWebRequestAllowed(new URL(path, "https://demo.invalid").pathname, "GET", false))
    throw Error("path denied");
  const match = path.match(/^\/api\/v1\/conversations\/([^/?]+)(\/messages)?/);
  return match ? (match[2] ? messages : detail)(req(path), params(match[1]!)) : list(req(path));
}
beforeEach(() => {
  vi.stubEnv("DEMO_WEB_INGRESS_ONLY", "true");
  vi.stubEnv("DEMO_WEB_CHANNEL_ID", DEMO_WEB_CHANNEL);
  vi.stubEnv("DEMO_INBOUND_ONLY", "false");
  f.anonymous = false;
  f.roleDenied = false;
  f.activeOrg = org;
  f.errorTable = "";
  f.queries = [];
  f.options = [];
  f.tables = {
    channel_sessions: [{ id: DEMO_WEB_CHANNEL, organization_id: org, archived_at: null }],
    conversations: [
      {
        id: conversation,
        organization_id: org,
        channel_session_id: DEMO_WEB_CHANNEL,
        contact_id: contact,
        status: "open",
        assigned_to_user_id: null,
      },
      {
        id: otherConversation,
        organization_id: org,
        channel_session_id: off,
        contact_id: "other",
        status: "open",
      },
      {
        id: foreignConversation,
        organization_id: foreign,
        channel_session_id: DEMO_WEB_CHANNEL,
        contact_id: "foreign",
        status: "open",
      },
    ],
    contacts: [
      { id: contact, organization_id: org, is_anonymized: false },
      { id: "other", organization_id: org, is_anonymized: false },
    ],
    messages: [
      {
        id: "40000000-0000-4000-8000-000000000001",
        organization_id: org,
        channel_session_id: DEMO_WEB_CHANNEL,
        conversation_id: conversation,
        contact_id: contact,
        body: "Inbound demo",
        sent_at: "2026-10-11T00:00:00Z",
      },
      {
        id: "40000000-0000-4000-8000-000000000002",
        organization_id: org,
        channel_session_id: DEMO_WEB_CHANNEL,
        conversation_id: conversation,
        contact_id: contact,
        body: "AI reply",
        sent_at: "2026-10-11T00:00:01Z",
      },
      {
        id: "wrong-channel",
        organization_id: org,
        channel_session_id: off,
        conversation_id: conversation,
        contact_id: contact,
      },
      {
        id: "wrong-org",
        organization_id: foreign,
        channel_session_id: DEMO_WEB_CHANNEL,
        conversation_id: conversation,
        contact_id: contact,
      },
      {
        id: "wrong-contact",
        organization_id: org,
        channel_session_id: DEMO_WEB_CHANNEL,
        conversation_id: conversation,
        contact_id: "other",
      },
    ],
  };
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("authenticated 0230 Inbox reads", () => {
  it("list, detail and messages return only the tenant/channel-bound fixture", async () => {
    expect(
      (await (await read("/api/v1/conversations?limit=50&exclude_finished=true")).json()).data.map(
        (v: { id: string }) => v.id,
      ),
    ).toEqual([conversation]);
    expect((await (await read(`/api/v1/conversations/${conversation}`)).json()).data.id).toBe(
      conversation,
    );
    const rows = (
      await (await read(`/api/v1/conversations/${conversation}/messages?limit=50`)).json()
    ).data;
    expect(rows.map((v: { body: string }) => v.body).sort()).toEqual(["AI reply", "Inbound demo"]);
    for (const query of f.queries.filter((v) => ["conversations", "messages"].includes(v.table))) {
      expect(query.filters).toContainEqual(["eq", "organization_id", org]);
      expect(query.filters).toContainEqual(["eq", "channel_session_id", DEMO_WEB_CHANNEL]);
    }
  });
  it("actual hook query functions reach the real GET routes through an in-memory fetch", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const path = String(input);
        if (!path.startsWith("/api/v1/conversations")) throw Error("network forbidden");
        return read(path);
      }),
    );
    useConversationsRealtime({ exclude_finished: true }, org);
    useConversation(conversation, true);
    useMessagesRealtime(conversation);
    const results = await Promise.all(f.options.map((o) => o.queryFn({})));
    expect(results[0]).toMatchObject({ data: [{ id: conversation }] });
    expect(results[1]).toMatchObject({ id: conversation });
    expect(results[2]).toMatchObject({ data: [{}, {}] });
    expect(fetch).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  });
  it("denies malformed cross-tenant contact bindings even on a 0230 conversation", async () => {
    f.tables.contacts![0]!.organization_id = foreign;
    expect((await (await list(req("/api/v1/conversations"))).json()).data).toEqual([]);
    expect((await detail(req("/"), params(conversation))).status).toBe(404);
    expect((await messages(req("/"), params(conversation))).status).toBe(404);
    expect(f.queries.some((q) => q.table === "messages")).toBe(false);
    for (const query of f.queries.filter((q) => q.table === "conversations"))
      expect(query.filters).toContainEqual(["eq", "contacts.organization_id", org]);
  });
  it.each([otherConversation, foreignConversation])(
    "denies foreign/non-demo detail and messages: %s",
    async (id) => {
      expect((await detail(req(`/api/v1/conversations/${id}`), params(id))).status).toBe(404);
      expect((await messages(req(`/api/v1/conversations/${id}/messages`), params(id))).status).toBe(
        404,
      );
      expect(f.queries.some((q) => q.table === "messages")).toBe(false);
    },
  );
  it("denies an explicit 7270 list filter before querying", async () => {
    expect((await list(req(`/api/v1/conversations?channel_session_id=${off}`))).status).toBe(403);
    expect(f.queries).toEqual([]);
  });
  it("denies a foreign active organization", async () => {
    f.activeOrg = foreign;
    expect((await list(req("/api/v1/conversations"))).status).toBe(403);
    expect(f.queries.map((q) => q.table)).toEqual(["channel_sessions"]);
  });
  it.each(["list", "detail", "messages"])(
    "unauthenticated %s requests read no data",
    async (kind) => {
      f.anonymous = true;
      const res =
        kind === "list"
          ? await list(req("/api/v1/conversations"))
          : await (kind === "detail" ? detail : messages)(req("/"), params(conversation));
      expect(res.status).toBe(401);
      expect(f.queries).toEqual([]);
    },
  );
  it("fresh role denial fails closed before data queries", async () => {
    f.roleDenied = true;
    expect((await list(req("/api/v1/conversations"))).status).toBe(403);
    expect(f.queries).toEqual([]);
  });
  it.each(["conversations", "messages"])("fails closed on %s query errors", async (table) => {
    f.errorTable = table;
    const res = await messages(req("/"), params(conversation));
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await res.json()).data).toBeUndefined();
  });
  it.each(["missing", "ambiguous", "archived", "database"])(
    "denies %s channel binding",
    async (failure) => {
      if (failure === "missing") f.tables.channel_sessions = [];
      if (failure === "ambiguous") f.tables.channel_sessions!.push(f.tables.channel_sessions![0]!);
      if (failure === "archived") f.tables.channel_sessions![0]!.archived_at = "2026-01-01";
      if (failure === "database") f.errorTable = "channel_sessions";
      expect((await list(req("/api/v1/conversations"))).status).toBe(403);
      expect(f.queries.some((q) => q.table !== "channel_sessions")).toBe(false);
    },
  );
  it("domain handler rejects a forged tenant/actor without relying on the proxy", async () => {
    await expect(
      getConversationHandler(client, { ...ctx, organization_id: foreign }, conversation),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      demoInboxReadChannel(client, { ...ctx, actor: { type: "user", id: "forged" } }),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.queries).toEqual([]);
  });
  it("search reads contacts only through scoped conversation identities", async () => {
    expect((await list(req("/api/v1/conversations?search=demo"))).status).toBe(200);
    expect(f.queries.find((q) => q.table === "contacts")?.filters).toContainEqual([
      "in",
      "id",
      [contact],
    ]);
  });
  it("normal mode preserves existing channel access and skips the demo guard", async () => {
    vi.stubEnv("DEMO_WEB_INGRESS_ONLY", "false");
    f.roleDenied = true;
    const response = await list(req("/api/v1/conversations"));
    expect((await response.json()).data).toHaveLength(2);
    expect(f.queries.some((q) => q.table === "channel_sessions")).toBe(false);
  });
  it("invalid demo configuration fails closed", async () => {
    vi.stubEnv("DEMO_WEB_CHANNEL_ID", off);
    await expect(demoInboxReadChannel(client, ctx)).rejects.toThrow("demo_web_ingress_denied");
    expect(f.queries).toEqual([]);
  });
  it("direct patch and outbound remain denied before any database effect", async () => {
    await expect(
      patchConversationHandler(client, ctx, conversation, { status: "closed" }),
    ).rejects.toThrow("demo_web_ingress_denied");
    await expect(sendMessageHandler(client, ctx, {} as never)).rejects.toThrow(
      "demo_web_ingress_denied",
    );
    expect(f.queries).toEqual([]);
  });
  it.each(["POST", "PATCH", "DELETE", "PUT", "HEAD"])(
    "denies %s on every new read path",
    (method) => {
      for (const path of [
        "/api/v1/conversations",
        `/api/v1/conversations/${conversation}`,
        `/api/v1/conversations/${conversation}/messages`,
      ])
        expect(demoWebRequestAllowed(path, method, false)).toBe(false);
    },
  );
  it.each([
    "/api/v1/conversations/counts",
    "/api/v1/conversations/export",
    "/api/v1/conversations/bulk",
    "/api/v1/messages",
    "/api/v1/message-templates",
    `/api/v1/conversations/${conversation}/notes`,
  ])("denies unrelated/bulk/outbound path %s", (path) => {
    expect(demoWebRequestAllowed(path, "GET", false)).toBe(false);
  });
  it("read allowlist never admits Server Actions", () => {
    expect(demoWebRequestAllowed("/api/v1/conversations", "GET", true)).toBe(false);
  });
});
