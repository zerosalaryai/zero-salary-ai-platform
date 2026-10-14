import { demoCrmRecovery } from "./demo-crm-recovery";
import { transcribeDemoVoice } from "./demo-voice";
import { storagePathFor } from "@/lib/messaging/media/types";
import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AsyncLocalStorage } from "node:async_hooks";
import { createPool } from "@/lib/agent-engine/db/pool";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import type { EntradaDeMensagem } from "./pos-entrada";
import type { InboundMessageEvent } from "./meta/webhook";
import { ehPedidoDeOptOut, ehOptOutProvavel } from "@/lib/opt-out/deteccao";
import { DEMO_WEB_CHANNEL, DemoWebDenied, readDemoWebConfig } from "./demo-web-ingress";

interface Binding {
  id: string;
  organization_id: string;
  meta_waba_id: string;
  meta_phone_number_id: string;
  started_at: string;
}
interface Context {
  db: Queryable;
  binding: Binding;
  event?: InboundMessageEvent;
  token?: string;
}
const context = new AsyncLocalStorage<Context>();
let pool: ReturnType<typeof createPool> | undefined;
function database(): Queryable {
  if (!process.env.SUPABASE_DB_URL) throw new DemoWebDenied();
  return (pool ??= createPool(process.env.SUPABASE_DB_URL));
}
/** Sem fallback de schema: token + UUID + transporte, antes de qualquer mutação. */
export async function bindDemoWebToken(
  token: string,
  db: Queryable = database(),
): Promise<Context> {
  if (!readDemoWebConfig()) throw new DemoWebDenied();
  const { rows } = await db.query<Binding>(
    `
    select cs.id, cs.organization_id, cs.meta_waba_id, cs.meta_phone_number_id,
      clock_timestamp()::text as started_at
    from channel_sessions cs
    where cs.id=$1 and cs.webhook_path_token=$2 and cs.provider='meta_cloud'
      and cs.archived_at is null and cs.metadata->>'ai_gate'='open'
      and cs.phone_number ~ '^\\+?[1-9][0-9 ()-]{7,20}$'
      and right(regexp_replace(cs.phone_number, '[^0-9]', '', 'g'),4)='0230'
      and cs.meta_waba_id ~ '^[0-9]+$' and cs.meta_phone_number_id ~ '^[0-9]+$'
      and not exists (select 1 from channel_sessions other where other.id<>cs.id
        and other.archived_at is null and (other.webhook_path_token=cs.webhook_path_token
          or (other.provider='meta_cloud' and other.meta_phone_number_id=cs.meta_phone_number_id)))`,
    [DEMO_WEB_CHANNEL, token],
  );
  const binding = rows[0];
  if (
    rows.length !== 1 ||
    !binding ||
    binding.id !== DEMO_WEB_CHANNEL ||
    !/^[0-9a-f-]{36}$/i.test(binding.organization_id) ||
    !binding.meta_waba_id ||
    !binding.meta_phone_number_id ||
    !Number.isFinite(Date.parse(binding.started_at))
  )
    throw new DemoWebDenied();
  return { db, binding, token };
}
export async function withDemoWebInbound<T>(
  ctx: Context,
  event: InboundMessageEvent,
  action: () => Promise<T>,
): Promise<T> {
  if (
    event.wabaId !== ctx.binding.meta_waba_id ||
    event.phoneNumberId !== ctx.binding.meta_phone_number_id ||
    !event.externalId ||
    !Number.isFinite(event.sentAt.getTime())
  )
    throw new DemoWebDenied();
  return context.run({ ...ctx, event }, action);
}
export function demoWebSessionForIngest(organizationId: string, event: InboundMessageEvent) {
  assertDemoWebIngest(organizationId, event);
  const binding = context.getStore()?.binding;
  if (!binding) throw new DemoWebDenied();
  return { id: binding.id, organization_id: binding.organization_id };
}
export function assertDemoWebIngest(
  organizationId: string,
  event: InboundMessageEvent,
  sessionId?: string,
): void {
  if (!readDemoWebConfig()) return;
  const ctx = context.getStore();
  if (
    !ctx ||
    ctx.event !== event ||
    organizationId !== ctx.binding.organization_id ||
    (sessionId !== undefined && sessionId !== ctx.binding.id)
  )
    throw new DemoWebDenied();
}
/** The old split post-entry path may never emit a demo dispatch again. */
export async function dispatchDemoWebInbound(_input: EntradaDeMensagem): Promise<void> {
  throw new DemoWebDenied();
}

/** One server-only RPC owns all durable ingress mutations and completion. */
export async function ingestDemoWebAtomic(
  admin: SupabaseClient,
  event: InboundMessageEvent,
  organizationId: string,
): Promise<{ status: "ingested" | "duplicate"; messageId: string; conversationId: string }> {
  try {
    if (!readDemoWebConfig()) throw new DemoWebDenied();
    assertDemoWebIngest(organizationId, event);
    const ctx = context.getStore();
    if (!ctx?.token) throw new DemoWebDenied();
    const body = event.type === "contact" ? (event.sharedContact?.name ?? event.text) : event.text;
    const source = JSON.stringify({
      external_id: event.externalId,
      waba_id: event.wabaId,
      phone_number_id: event.phoneNumberId,
      from: event.from,
      sent_at: event.sentAt.toISOString(),
      type: event.type,
      body,
      profile_name: event.profileName,
      media_url: event.media ? `meta-media:${event.media.id}` : null,
      media_mime: event.media?.mime ?? null,
      metadata: {
        ...(event.media ? { meta_media_id: event.media.id, voice: event.media.voice } : {}),
        ...(event.sharedContact ? { shared_contact: event.sharedContact } : {}),
      },
    });
    const voice = demoCrmRecovery() && event.type === "audio" ?
      event.media ? await transcribeDemoVoice(organizationId, ctx.binding.meta_phone_number_id, event.media) : (() => { throw new DemoWebDenied(); })() : null;
    const optOutText = voice?.text ?? body;
    const { data, error } = await admin.rpc(
      (demoCrmRecovery() ? "fn_demo_ingest_meta_recovery" : "fn_demo_ingest_meta") as never,
      {
        p_token: ctx.token,
        p_org: organizationId,
        p_channel: ctx.binding.id,
        p_waba: ctx.binding.meta_waba_id,
        p_phone: ctx.binding.meta_phone_number_id,
        p_admitted_at: ctx.binding.started_at,
        p_source: source,
        p_fingerprint: createHash("sha256").update(source).digest("hex"),
        p_opt_out: ehPedidoDeOptOut(optOutText) || ehOptOutProvavel(optOutText),
        ...(demoCrmRecovery() ? { p_transcript: voice?.text ?? null } : {}),
      } as never,
    );
    const r = data as Record<string, unknown> | null;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (
      error ||
      !r ||
      typeof r.duplicate !== "boolean" ||
      typeof r.message_id !== "string" ||
      !uuid.test(r.message_id) ||
      typeof r.conversation_id !== "string" ||
      !uuid.test(r.conversation_id) ||
      !["dispatch_recorded", "opted_out", "blocked", "human_takeover", "stored_nontext"].includes(
        String(r.outcome),
      ) ||
      (r.outcome === "dispatch_recorded"
        ? typeof r.dispatch_event_id !== "string" || !uuid.test(r.dispatch_event_id)
        : r.dispatch_event_id !== null)
    )
      throw new DemoWebDenied();
    if (voice) {
      const path = storagePathFor(organizationId, String(r.conversation_id), String(r.message_id), voice.mime);
      const uploaded = await admin.storage.from("whatsapp-media").upload(path, voice.buffer, { contentType: voice.mime, upsert: false });
      // Receipt/dispatch already committed. Storage failure must never generate a second event.
      if (!uploaded.error) await admin.from("messages").update({ media_storage_path: path, media_mime: voice.mime, media_size_bytes: voice.buffer.byteLength })
        .eq("id", String(r.message_id)).eq("organization_id", organizationId).eq("channel_session_id", ctx.binding.id);
    }
    return {
      status: r.duplicate ? "duplicate" : "ingested",
      messageId: r.message_id,
      conversationId: r.conversation_id,
    };
  } catch {
    // Includes uncertain RPC commits: provider retries resolve the durable receipt.
    throw new DemoWebDenied();
  }
}
