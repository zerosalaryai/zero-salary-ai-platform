import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, expect, it, vi } from "vitest";
import { ingestMetaInbound } from "@/lib/channels/meta/ingest";
import type { InboundMessageEvent } from "@/lib/channels/meta/webhook";

vi.mock("@/lib/channels/contato-por-telefone", () => ({
  encontrarContatoPorTelefone: async () => null,
}));
vi.mock("@/lib/escalacao/numero-interno-de-aviso", () => ({
  ehNumeroInternoDeAviso: async () => false,
}));
const f = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock("@/lib/channels/pos-entrada", () => ({ aplicarEfeitosPosEntrada: f.post }));
afterEach(() => vi.unstubAllEnvs());

it("preserves normal-mode duplicate acknowledgement without post-entry effects", async () => {
  vi.stubEnv("DEMO_WEB_INGRESS_ONLY", "false");
  const query = {
    select: () => query,
    eq: () => query,
    is: () => query,
    maybeSingle: async () => ({ data: { id: "session", organization_id: "org" }, error: null }),
  };
  const insert = vi.fn(() => ({
    select: () => ({ maybeSingle: async () => ({ data: null, error: { code: "23505" } }) }),
  }));
  const rpc = vi.fn(async (name: string) => ({
    data: name === "fn_upsert_wa_contact" ? "contact" : "conversation",
    error: null,
  }));
  const admin = {
    from: (table: string) => (table === "channel_sessions" ? query : { insert }),
    rpc,
  } as unknown as SupabaseClient;
  const event: InboundMessageEvent = {
    kind: "inbound_message",
    wabaId: "waba",
    phoneNumberId: "phone",
    externalId: "unit-duplicate",
    from: "15555550101",
    profileName: null,
    sentAt: new Date("2026-10-10T00:00:00Z"),
    type: "text",
    text: "Hello",
    media: null,
  };
  await expect(ingestMetaInbound(admin, event, { organizationId: "org" })).resolves.toEqual({
    status: "duplicate",
  });
  expect(insert).toHaveBeenCalledOnce();
  expect(rpc.mock.calls.map((c) => c[0])).toEqual([
    "fn_upsert_wa_contact",
    "fn_upsert_wa_conversation",
  ]);
  expect(f.post).not.toHaveBeenCalled();
});
