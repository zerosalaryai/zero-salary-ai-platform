import "server-only";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Queryable } from "@/lib/agent-engine/queue/queue";
import type { DemoBinding } from "./demo-inbound-only";
import { demoCrmRecovery } from "./demo-crm-recovery";
import { DEMO_WEB_CHANNEL } from "./demo-web-ingress";

export interface StaffDelivery {
  id: string; organization_id: string; channel_session_id: string; conversation_id: string;
  contact_id: string; actor_id: string; message_id: string; body: string; status: string;
}
const current = new AsyncLocalStorage<{ db: Queryable; binding: DemoBinding; row: StaffDelivery }>();
/** Called only by the bound worker after the atomic one-attempt claim. */
export async function withDemoStaffDelivery<T>(db: Queryable, binding: DemoBinding, row: StaffDelivery, action: () => Promise<T>): Promise<T> {
  if (!demoCrmRecovery() || process.env.DEMO_INBOUND_ONLY !== "true" || process.env.DEMO_WEB_INGRESS_ONLY === "true" ||
      binding.channelId !== DEMO_WEB_CHANNEL || row.channel_session_id !== binding.channelId || row.organization_id !== binding.organizationId || row.status !== "sending")
    throw new Error("demo_staff_denied");
  return current.run({ db, binding, row }, async () => { await assertDemoStaffDelivery(row.organization_id, row.conversation_id); return action(); });
}
export async function assertDemoStaffDelivery(org: string, conversation?: string, transport?: {sessionRef: string; to: string; kind: string}): Promise<boolean> {
  const ctx = current.getStore();
  if (!ctx) return false;
  if (!demoCrmRecovery() || org !== ctx.binding.organizationId || (conversation !== undefined && conversation !== ctx.row.conversation_id)) throw new Error("demo_staff_denied");
  const { rows } = await ctx.db.query<{ session_ref: string; recipient: string }>(`
    select cs.meta_phone_number_id as session_ref,ct.phone_number as recipient
    from demo_staff_deliveries d
    join messages m on m.id=d.message_id and m.organization_id=d.organization_id
      and m.conversation_id=d.conversation_id and m.contact_id=d.contact_id and m.channel_session_id=d.channel_session_id
      and m.direction='outbound' and m.type='text' and m.body=d.body and m.sent_by_user_id=d.actor_id
      and m.status='queued'
    join conversations cv on cv.id=d.conversation_id and cv.organization_id=d.organization_id
      and cv.contact_id=d.contact_id and cv.channel_session_id=d.channel_session_id
    join contacts ct on ct.id=d.contact_id and ct.organization_id=d.organization_id
    join channel_sessions cs on cs.id=d.channel_session_id and cs.organization_id=d.organization_id
    where d.id=$1 and d.organization_id=$2 and d.channel_session_id=$3 and d.status='sending'
      and d.actor_id=$4 and d.message_id=$5 and d.body=$6 and d.created_at>=$7::timestamptz
      and cv.assigned_to_user_id=d.actor_id and cv.is_group is false
      and cv.status not in('closed','resolved','archived') and cv.last_inbound_at>now()-interval '24 hours'
      and ct.is_blocked is false and ct.is_anonymized is false and ct.is_merged_into is null
      and cs.provider='meta_cloud' and cs.archived_at is null and cs.metadata->>'ai_gate'='open'
      and right(regexp_replace(cs.phone_number,'[^0-9]','','g'),4)='0230'
      and cs.meta_waba_id ~ '^[0-9]+$'
      and not exists(select 1 from channel_sessions other where other.organization_id=cs.organization_id
        and other.id<>cs.id and other.archived_at is null and other.meta_phone_number_id=cs.meta_phone_number_id)
      and not exists(select 1 from conversations other where other.organization_id=cv.organization_id
        and other.contact_id=ct.id and other.channel_session_id<>cs.id)
      and public.fn_member_role_in_org(d.actor_id,d.organization_id) in('agent','manager','admin')`,
    [ctx.row.id, org, ctx.binding.channelId, ctx.row.actor_id, ctx.row.message_id, ctx.row.body, ctx.binding.startedAt]);
  const r = rows[0];
  if (rows.length !== 1 || !r || !/^[0-9]+$/.test(r.session_ref) || !/^\+?[1-9][0-9]{7,14}$/.test(r.recipient)) throw new Error("demo_staff_denied");
  if (transport && (transport.kind !== "text" || transport.sessionRef !== r.session_ref || transport.to !== r.recipient.replace(/\D/g, ""))) throw new Error("demo_staff_denied");
  return true;
}
