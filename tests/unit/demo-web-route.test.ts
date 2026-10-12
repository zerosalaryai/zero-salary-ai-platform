import { createHmac } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_WEB_CHANNEL } from "@/lib/channels/demo-web-ingress";
const f = vi.hoisted(() => ({
  query: vi.fn(),
  session: vi.fn(),
  rpc: vi.fn(),
  insert: vi.fn(),
  duplicate: false,
  body: "Hello",
  safe: true,
  appRows: [] as unknown[],
  appError: null as { code: string } | null,
  decrypt: vi.fn(),
}));
vi.mock("@/lib/channels/meta/session", () => ({ metaSessionByWebhookToken: f.session }));
vi.mock("@/lib/agent-engine/db/pool", () => ({ createPool: () => ({ query: f.query }) }));
vi.mock("@/lib/webhooks/secrets", () => ({ decryptWebhookSecret: f.decrypt }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    rpc: f.rpc,
    from: (table: string) => {
      if (table === "platform_meta_app")
        return {
          select: () => ({
            eq: () => ({ limit: async () => ({ data: f.appRows, error: f.appError }) }),
          }),
        };
      if (table !== "messages") throw Error("unexpected table " + table);
      return {
        insert: (row: unknown) => {
          f.insert(row);
          return {
            select: () => ({
              maybeSingle: async () =>
                f.duplicate
                  ? { data: null, error: { code: "23505" } }
                  : { data: { id: "40000000-0000-4000-8000-000000000004" }, error: null },
            }),
          };
        },
      };
    },
  }),
}));
vi.mock("@/lib/channels/contato-por-telefone", () => ({
  encontrarContatoPorTelefone: async () => null,
}));
vi.mock("@/lib/escalacao/numero-interno-de-aviso", () => ({
  ehNumeroInternoDeAviso: async () => false,
  registrarMensagemIgnorada: vi.fn(),
}));
vi.mock("@/lib/leads/atribuicao-de-anuncio", () => ({
  estamparAtribuicaoDoContato: () => {
    throw Error("attribution forbidden");
  },
  obj: (x: unknown) => x,
  str: (x: unknown) => (typeof x === "string" ? x : null),
}));
import { GET, POST } from "@/app/api/v1/webhooks/meta/[token]/route";
const org = "10000000-0000-4000-8000-000000000001";
const channel = {
  id: DEMO_WEB_CHANNEL,
  organization_id: org,
  meta_waba_id: "111",
  meta_phone_number_id: "222",
  started_at: "2026-10-10T00:00:00Z",
};
function request({
  waba = "111",
  phone = "222",
  signature = true,
  type = "text",
  status = false,
  signingKey = "unit-only-signing-key",
} = {}) {
  const body = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: waba,
        changes: [
          {
            field: "messages",
            value: {
              metadata: { phone_number_id: phone },
              ...(status
                ? {
                    statuses: [
                      {
                        id: "test-wamid",
                        status: "delivered",
                        timestamp: "1791597600",
                        recipient_id: "15555550101",
                      },
                    ],
                  }
                : {
                    messages: [
                      {
                        id: "test-wamid",
                        from: "15555550101",
                        timestamp: "1791597600",
                        type,
                        ...(type === "text"
                          ? { text: { body: f.body } }
                          : { image: { id: "test-media", mime_type: "image/jpeg" } }),
                      },
                    ],
                  }),
            },
          },
        ],
      },
    ],
  });
  return new NextRequest("https://demo.invalid/api/v1/webhooks/meta/unit-token", {
    method: "POST",
    body,
    headers: {
      "x-hub-signature-256": signature
        ? "sha256=" + createHmac("sha256", signingKey).update(body).digest("hex")
        : "invalid",
    },
  });
}
const ctx = () => ({ params: Promise.resolve({ token: "unit-token" }) });
beforeEach(() => {
  vi.stubEnv("DEMO_WEB_INGRESS_ONLY", "true");
  vi.stubEnv("DEMO_WEB_CHANNEL_ID", DEMO_WEB_CHANNEL);
  vi.stubEnv("DEMO_INBOUND_ONLY", "false");
  vi.stubEnv("SUPABASE_DB_URL", "postgres://unit:unit@invalid/unit");
  f.query.mockReset();
  f.session.mockReset();
  f.rpc.mockReset();
  f.insert.mockReset();
  f.duplicate = false;
  f.body = "Hello";
  f.safe = true;
  f.appRows = [
    { id: 1, app_secret_encrypted: "cipher-secret", verify_token_encrypted: "cipher-token" },
  ];
  f.appError = null;
  f.decrypt.mockReset();
  f.decrypt.mockImplementation(async (_admin: unknown, cipher: string) =>
    cipher === "cipher-secret" ? "unit-only-signing-key" : "unit-only-verify",
  );
  f.query.mockImplementation(async (sql: string) => ({
    rows: sql.includes("clock_timestamp")
      ? [channel]
      : sql.includes("select m.body")
        ? [{ body: f.body, type: sql.includes("never") ? "never" : "text", safe: f.safe }]
        : sql.includes("update contacts")
          ? [{ id: "contact" }]
          : [],
  }));
  f.rpc.mockResolvedValue({ data: receipt(), error: null });
});
afterEach(() => vi.unstubAllEnvs());

function receipt(outcome = "dispatch_recorded", duplicate = false) {
  return {
    duplicate,
    message_id: "40000000-0000-4000-8000-000000000004",
    conversation_id: "20000000-0000-4000-8000-000000000002",
    outcome,
    dispatch_event_id:
      outcome === "dispatch_recorded" ? "50000000-0000-4000-8000-000000000005" : null,
  };
}
describe("signed Meta 0230 atomic ingress", () => {
  it.each(["GET", "POST"])("rejects an unknown demo path token before credentials or ingress: %s", async (method) => {
    f.query.mockImplementation(async (_sql: string, binds: unknown[]) => ({
      rows: binds[1] === "unit-token" ? [channel] : [],
    }));
    const invalid = { params: Promise.resolve({ token: "unit-invalid-token" }) };
    const handler = method === "GET" ? GET : POST;
    await expect(handler(request(), invalid)).rejects.toThrow("demo_web_ingress_denied");
    expect(f.query.mock.calls[0]?.[1]).toEqual([DEMO_WEB_CHANNEL, "unit-invalid-token"]);
    expect(f.decrypt).not.toHaveBeenCalled();
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.insert).not.toHaveBeenCalled();
    expect(f.session).not.toHaveBeenCalled();
  });
  it.each(["GET", "POST"])("normal-mode unknown path token returns the route's own 404: %s", async (method) => {
    vi.stubEnv("DEMO_WEB_INGRESS_ONLY", "false");
    f.session.mockResolvedValue(null);
    const invalid = { params: Promise.resolve({ token: "unit-invalid-token" }) };
    const response = await (method === "GET" ? GET : POST)(request(), invalid);
    expect(response.status).toBe(404);
    if (method === "GET") expect(await response.text()).toBe("not found");
    else expect(await response.json()).toMatchObject({ error: { code: "not_found", message: "unknown webhook token" } });
    expect(f.session).toHaveBeenCalledWith("unit-invalid-token");
    expect(f.query).not.toHaveBeenCalled();
    expect(f.decrypt).not.toHaveBeenCalled();
    expect(f.rpc).not.toHaveBeenCalled();
    expect(f.insert).not.toHaveBeenCalled();
  });
  it.each(["42883", "PGRST202"])("missing migration RPC fails closed without split-ingestion fallback: %s", async (code) => {
    f.rpc.mockResolvedValue({ data: null, error: { code, message: "synthetic missing function" } });
    await expect(POST(request(), ctx())).rejects.toThrow("demo_web_ingress_denied");
    expect(f.rpc.mock.calls.map((call) => call[0])).toEqual(["fn_demo_ingest_meta"]);
    expect(f.query).toHaveBeenCalledOnce(); // read-only binding only
    expect(f.insert).not.toHaveBeenCalled();
    expect(f.session).not.toHaveBeenCalled();
  });
  it("delegates all mutations to exactly one hardened RPC after binding and HMAC", async () => {
    expect((await POST(request(), ctx())).status).toBe(200);
    expect(f.rpc).toHaveBeenCalledOnce();
    expect(f.rpc.mock.calls[0]?.[0]).toBe("fn_demo_ingest_meta");
    expect(f.rpc.mock.calls[0]?.[1]).toMatchObject({
      p_org: org,
      p_channel: DEMO_WEB_CHANNEL,
      p_token: "unit-token",
      p_waba: "111",
      p_phone: "222",
      p_opt_out: false,
    });
    const args = f.rpc.mock.calls[0]?.[1];
    expect(JSON.parse(args.p_source)).toMatchObject({
      external_id: "test-wamid",
      from: "15555550101",
      body: "Hello",
    });
    expect(args.p_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(f.insert).not.toHaveBeenCalled();
    expect(f.query).toHaveBeenCalledOnce(); // binding lookup only; no split dispatch
  });
  it("acknowledges a completed duplicate only from the atomic receipt result", async () => {
    f.rpc.mockResolvedValue({ data: receipt("dispatch_recorded", true), error: null });
    const res = await POST(request(), ctx());
    expect(await res.json()).toMatchObject({ outcomes: ["duplicate"] });
    expect(f.rpc).toHaveBeenCalledOnce();
    expect(f.insert).not.toHaveBeenCalled();
  });
  it.each(["blocked", "human_takeover", "opted_out", "stored_nontext"])(
    "accepts terminal %s without separate dispatch",
    async (outcome) => {
      f.rpc.mockResolvedValue({ data: receipt(outcome), error: null });
      expect((await POST(request(), ctx())).status).toBe(200);
      expect(f.rpc.mock.calls.map((c) => c[0])).toEqual(["fn_demo_ingest_meta"]);
    },
  );
  it("forwards strict opt-out to the same transaction", async () => {
    f.body = "STOP";
    f.rpc.mockResolvedValue({ data: receipt("opted_out"), error: null });
    await POST(request(), ctx());
    expect(f.rpc.mock.calls[0]?.[1].p_opt_out).toBe(true);
  });
  it.each([
    "legacy_message",
    "identity_mismatch",
    "optout_failure",
    "eligibility_unknown",
    "old_event",
    "database_error",
  ])("fails closed on atomic %s", async (reason) => {
    f.rpc.mockResolvedValue({ data: null, error: { message: reason } });
    await expect(POST(request(), ctx())).rejects.toThrow(/^demo_web_ingress_denied$/);
    expect(f.insert).not.toHaveBeenCalled();
    expect(f.rpc).toHaveBeenCalledOnce();
  });
  it("retries a commit-uncertain RPC using identical source identity and accepts its durable result", async () => {
    f.rpc.mockRejectedValueOnce(Error("unit commit acknowledgement lost"));
    await expect(POST(request(), ctx())).rejects.toThrow("demo_web_ingress_denied");
    f.rpc.mockResolvedValueOnce({ data: receipt("dispatch_recorded", true), error: null });
    f.query.mockResolvedValueOnce({ rows: [{ ...channel, started_at: "2026-10-10T00:00:01Z" }] });
    expect((await POST(request(), ctx())).status).toBe(200);
    const first = f.rpc.mock.calls[0]?.[1];
    const retry = f.rpc.mock.calls[1]?.[1];
    expect(retry).toMatchObject({
      p_source: first.p_source,
      p_fingerprint: first.p_fingerprint,
      p_org: first.p_org,
      p_channel: first.p_channel,
      p_token: first.p_token,
    });
    expect(retry.p_admitted_at).not.toBe(first.p_admitted_at);
    expect(f.insert).not.toHaveBeenCalled();
  });
  it.each([
    null,
    {},
    receipt("pending"),
    { ...receipt(), dispatch_event_id: null },
    { ...receipt(), message_id: "wrong" },
  ])("rejects malformed/incomplete completion result %#", async (data) => {
    f.rpc.mockResolvedValue({ data, error: null });
    await expect(POST(request(), ctx())).rejects.toThrow("demo_web_ingress_denied");
  });
  it("persists nontext only through the transaction, without media jobs", async () => {
    f.rpc.mockResolvedValue({ data: receipt("stored_nontext"), error: null });
    await POST(request({ type: "image" }), ctx());
    expect(JSON.parse(f.rpc.mock.calls[0]?.[1].p_source)).toMatchObject({
      type: "image",
      media_url: "meta-media:test-media",
    });
    expect(f.rpc.mock.calls.map((c) => c[0])).toEqual(["fn_demo_ingest_meta"]);
  });
  it("ignores status updates", async () => {
    await POST(request({ status: true }), ctx());
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it.each([{ waba: "other" }, { phone: "other" }])(
    "rejects transport mismatch before RPC",
    async (options) => {
      await expect(POST(request(options), ctx())).rejects.toThrow();
      expect(f.rpc).not.toHaveBeenCalled();
    },
  );
  it("rejects bad and environment-signed HMAC before RPC", async () => {
    vi.stubEnv("META_APP_SECRET", "unit-env-secret");
    for (const req of [request({ signature: false }), request({ signingKey: "unit-env-secret" })]) {
      expect((await POST(req, ctx())).status).toBe(401);
    }
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it.each(["query", "missing", "ambiguous", "decrypt"])(
    "denies %s credential failure before atomic ingress",
    async (failure) => {
      vi.stubEnv("META_APP_SECRET", "unit-only-signing-key");
      if (failure === "query") f.appError = { code: "unit-error" };
      if (failure === "missing") f.appRows = [];
      if (failure === "ambiguous") f.appRows = [...f.appRows, ...f.appRows];
      if (failure === "decrypt") f.decrypt.mockResolvedValue(null);
      await expect(POST(request(), ctx())).rejects.toThrow("demo_web_ingress_denied");
      await expect(
        GET(new NextRequest("https://demo.invalid/api/v1/webhooks/meta/unit-token"), ctx()),
      ).rejects.toThrow();
      expect(f.rpc).not.toHaveBeenCalled();
    },
  );
  it("uses only the database verify token for handshake", async () => {
    vi.stubEnv("META_WEBHOOK_VERIFY_TOKEN", "unit-env-token");
    for (const [token, status] of [
      ["unit-only-verify", 200],
      ["unit-env-token", 403],
    ] as const) {
      expect(
        (
          await GET(
            new NextRequest(
              `https://demo.invalid/api/v1/webhooks/meta/unit-token?hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=123`,
            ),
            ctx(),
          )
        ).status,
      ).toBe(status);
    }
    expect(f.rpc).not.toHaveBeenCalled();
  });
  it("rejects missing, foreign and ambiguous channel bindings before mutations", async () => {
    for (const rows of [
      [],
      [{ ...channel, id: "df10c6c2" }],
      [channel, channel],
      [{ ...channel, organization_id: "wrong" }],
    ]) {
      f.query.mockResolvedValue({ rows });
      await expect(POST(request(), ctx())).rejects.toThrow();
    }
    expect(f.rpc).not.toHaveBeenCalled();
  });
});
