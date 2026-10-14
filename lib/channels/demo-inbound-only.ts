import { demoCrmRecovery } from "./demo-crm-recovery";
import { assertDemoStaffDelivery } from "./demo-staff-delivery";
import { denyDemoWebAction } from "./demo-web-ingress";
/** Opt-in local do worker: identidade durável, nenhum fallback por payload/prefixo. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Queryable, JobRow } from "@/lib/agent-engine/queue/queue";
import { ehOptOutProvavel, ehPedidoDeOptOut } from "@/lib/opt-out/deteccao";

export interface DemoBinding {
  channelId: string;
  organizationId: string;
  startedAt: string;
}
export class DemoIsolationError extends Error {
  readonly terminal = true;
  constructor() {
    super("demo_inbound_only_denied");
    this.name = "DemoIsolationError";
  }
}
const DEMO_CHANNEL_ID = "c67e9f8a-8719-4481-9154-ed8a464f85bd";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function readDemoConfig(
  source: Record<string, unknown> = process.env,
): { channelId: string } | null {
  const enabled = source.DEMO_INBOUND_ONLY;
  if (enabled === undefined || enabled === "" || enabled === "false") return null;
  const id = source.DEMO_CHANNEL_ID;
  if (enabled !== "true" || typeof id !== "string" || !UUID.test(id) || id !== DEMO_CHANNEL_ID)
    throw new DemoIsolationError();
  return { channelId: id };
}
let workerBinding: DemoBinding | undefined;
/** O modo do processo, uma vez armado no boot, não pode ser desarmado por tools. */
export function activateDemoWorker(binding: DemoBinding): void {
  readDemoConfig({ DEMO_INBOUND_ONLY: "true", DEMO_CHANNEL_ID: binding.channelId });
  if (
    !UUID.test(binding.organizationId) ||
    !Number.isFinite(Date.parse(binding.startedAt)) ||
    workerBinding
  )
    throw new DemoIsolationError();
  workerBinding = Object.freeze({ ...binding });
}
/** O claim direto também exige escopo válido; nunca cai no SQL global em demo. */
export function assertDemoClaimBinding(binding?: DemoBinding): void {
  const configured = workerBinding ?? readDemoConfig();
  if (!binding) {
    if (configured) throw new DemoIsolationError();
    return;
  }
  readDemoConfig({ DEMO_INBOUND_ONLY: "true", DEMO_CHANNEL_ID: binding.channelId });
  if (
    !UUID.test(binding.organizationId) ||
    !Number.isFinite(Date.parse(binding.startedAt)) ||
    (workerBinding &&
      (binding.channelId !== workerBinding.channelId ||
        binding.organizationId !== workerBinding.organizationId ||
        binding.startedAt !== workerBinding.startedAt))
  )
    throw new DemoIsolationError();
}
export function demoInboundOnly(): boolean {
  return workerBinding !== undefined || readDemoConfig() !== null;
}

interface ChannelRow {
  id: string;
  organization_id: string;
  provider: string;
  phone_number: string | null;
  metadata: Record<string, unknown> | null;
  archived_at: string | null;
  meta_phone_number_id: string | null;
}
function validChannel(row: ChannelRow, channelId: string): boolean {
  return (
    row.id === channelId &&
    row.provider === "meta_cloud" &&
    row.archived_at === null &&
    typeof row.phone_number === "string" &&
    /^\+?[1-9][0-9 ()-]{7,20}$/.test(row.phone_number) &&
    row.phone_number.replace(/\D/g, "").endsWith("0230") &&
    row.metadata?.ai_gate === "open" &&
    typeof row.meta_phone_number_id === "string" &&
    /^[0-9]+$/.test(row.meta_phone_number_id)
  );
}
/** Só SELECT. O corte de frescor vem do relógio do banco, antes de qualquer loop. */
export async function bindDemoChannel(
  db: Queryable,
  config: { channelId: string },
): Promise<DemoBinding> {
  if (readDemoConfig({ DEMO_INBOUND_ONLY: "true", DEMO_CHANNEL_ID: config.channelId }) === null)
    throw new DemoIsolationError();
  const { rows } = await db.query<ChannelRow & { started_at: string }>(
    `select id, organization_id, provider, phone_number, metadata, archived_at,
       meta_phone_number_id, clock_timestamp()::text as started_at
     from channel_sessions where id = $1 or (archived_at is null and (
       provider='meta_cloud' and meta_phone_number_id=(
         select bound.meta_phone_number_id from channel_sessions bound where bound.id=$1
       )))
     limit 2`,
    [config.channelId],
  );
  const row = rows[0];
  if (
    rows.length !== 1 ||
    !row ||
    !validChannel(row, config.channelId) ||
    !UUID.test(row.organization_id) ||
    !Number.isFinite(Date.parse(row.started_at))
  )
    throw new DemoIsolationError();
  return { channelId: row.id, organizationId: row.organization_id, startedAt: row.started_at };
}
export interface DemoInbound {
  organizationId: string;
  conversationId: string;
  contactId: string;
  channelId: string;
  inboundMessageId: string;
  eventId: string;
}
/** Revalida joins tenant-aware, origem inbound fresca e todas as travas antes de agir. */
export async function assertDemoInbound(
  db: Queryable,
  binding: DemoBinding,
  input: DemoInbound,
): Promise<{ sessionRef: string; recipient: string }> {
  assertDemoClaimBinding(binding);
  if (
    input.organizationId !== binding.organizationId ||
    input.channelId !== binding.channelId ||
    ![input.conversationId, input.contactId, input.inboundMessageId, input.eventId].every(
      (v) => typeof v === "string" && UUID.test(v),
    )
  )
    throw new DemoIsolationError();
  const { rows } = await db.query<
    ChannelRow & {
      safe: boolean;
      recipient: string | null;
      latest_body: string | null;
      latest_inbound_id: string | null;
    }
  >(
    `select cs.id, cs.organization_id, cs.provider, cs.phone_number, cs.metadata, cs.archived_at,
       cs.meta_phone_number_id, ct.phone_number as recipient,
       (select id::text from messages lm where lm.organization_id=cv.organization_id and lm.conversation_id=cv.id
        and lm.direction='inbound' order by coalesce(lm.sent_at,lm.created_at) desc, lm.created_at desc, lm.id desc limit 1) as latest_inbound_id,
       (select coalesce(lm.body, case when lm.type='audio' and lm.media_derived_status='ready' then lm.media_derived_text end) from messages lm where lm.organization_id=cv.organization_id and lm.conversation_id=cv.id
        and lm.direction='inbound' order by coalesce(lm.sent_at,lm.created_at) desc, lm.created_at desc, lm.id desc limit 1) as latest_body,
       (ct.is_blocked is false and ct.force_human is false and cv.is_group is false
        ${demoCrmRecovery() ? `and not exists(select 1 from conversations other where other.organization_id=cv.organization_id
          and other.contact_id=ct.id and other.channel_session_id<>cs.id)` : ''}
        and (cv.assignee_kind is null or cv.assignee_kind='ai')
        and not exists (select 1 from conversations h where h.organization_id=ct.organization_id
          and h.contact_id=ct.id and h.bot_silenced_until > now())
        and m.created_at >= $7::timestamptz and coalesce(m.sent_at,m.created_at) >= $7::timestamptz
        and e.created_at >= $7::timestamptz
        and e.event_type='ai_agent.dispatch_requested'
        and e.payload->>'conversation_id'=cv.id::text and e.payload->>'contact_id'=ct.id::text
        and e.payload->>'channel_session_id'=cs.id::text and e.payload->>'inbound_message_id'=m.id::text) as safe
     from conversations cv
     join contacts ct on ct.id=cv.contact_id and ct.organization_id=cv.organization_id
     join channel_sessions cs on cs.id=cv.channel_session_id and cs.organization_id=cv.organization_id
     join messages m on m.id=$5 and m.organization_id=cv.organization_id and m.conversation_id=cv.id
       and m.contact_id=ct.id and m.channel_session_id=cs.id and m.direction='inbound'
     join event_log e on e.id=$6 and e.organization_id=cv.organization_id
     where cv.organization_id=$1 and cv.id=$2 and ct.id=$3 and cs.id=$4`,
    [
      input.organizationId,
      input.conversationId,
      input.contactId,
      input.channelId,
      input.inboundMessageId,
      input.eventId,
      binding.startedAt,
    ],
  );
  const r = rows[0];
  if (
    rows.length !== 1 ||
    !r ||
    !validChannel(r, binding.channelId) ||
    r.safe !== true ||
    typeof r.recipient !== "string" ||
    !/^\+?[1-9][0-9]{7,14}$/.test(r.recipient) ||
    r.latest_inbound_id !== input.inboundMessageId ||
    typeof r.latest_body !== "string" ||
    ehPedidoDeOptOut(r.latest_body) ||
    ehOptOutProvavel(r.latest_body)
  )
    throw new DemoIsolationError();
  return { sessionRef: r.meta_phone_number_id!, recipient: r.recipient.replace(/\D/g, "") };
}
export function demoInputFromJob(job: JobRow): DemoInbound {
  if (job.kind !== "inbound_turn" || !job.contact_id || !job.source_event_id)
    throw new DemoIsolationError();
  const p = job.payload;
  if (p.contact_id !== job.contact_id) throw new DemoIsolationError();
  return {
    organizationId: job.organization_id,
    contactId: job.contact_id,
    eventId: job.source_event_id,
    conversationId: p.conversation_id as string,
    channelId: p.channel_session_id as string,
    inboundMessageId: p.inbound_message_id as string,
  };
}
interface DemoExecution {
  db: Queryable;
  binding: DemoBinding;
  job: JobRow;
}
const execution = new AsyncLocalStorage<DemoExecution>();
export async function withDemoInbound<T>(
  db: Queryable,
  binding: DemoBinding,
  job: JobRow,
  action: () => Promise<T>,
): Promise<T> {
  await assertDemoInbound(db, binding, demoInputFromJob(job));
  return execution.run({ db, binding, job }, action);
}
/** Sem contexto de job validado não há envio, nem mesmo uma notificação automática. */
export async function assertDemoOutbound(
  organizationId: string,
  conversationId: string,
  jobId?: string,
): Promise<void> {
  if (await assertDemoStaffDelivery(organizationId, conversationId)) return;
  if (!demoInboundOnly()) return;
  const ctx = execution.getStore();
  if (
    !ctx ||
    ctx.job.organization_id !== organizationId ||
    ctx.job.payload.conversation_id !== conversationId ||
    (jobId !== undefined && ctx.job.id !== jobId)
  )
    throw new DemoIsolationError();
  await assertCurrentDemoJob(ctx);
}
/** A cadeia tem job/canal/contato; a conversa vem do contexto durável, nunca do modelo. */
export async function assertDemoBeforeSend(input: {
  tenantId: string;
  leadId: string;
  channelSessionId: string;
  jobId?: string;
}): Promise<void> {
  if (!demoInboundOnly()) return;
  const ctx = execution.getStore();
  if (
    !ctx ||
    input.jobId !== ctx.job.id ||
    input.leadId !== ctx.job.contact_id ||
    input.channelSessionId !== ctx.binding.channelId
  )
    throw new DemoIsolationError();
  await assertDemoOutbound(input.tenantId, ctx.job.payload.conversation_id as string, input.jobId);
}
async function assertCurrentDemoJob(
  ctx: DemoExecution,
): Promise<{ sessionRef: string; recipient: string }> {
  const config = workerBinding ?? readDemoConfig();
  if (!config || config.channelId !== ctx.binding.channelId) throw new DemoIsolationError();
  const { rows } = await ctx.db.query<JobRow>(
    "select *, locked_at::text as claim_acquired_at from job_queue where id=$1 and organization_id=$2",
    [ctx.job.id, ctx.binding.organizationId],
  );
  const job = rows[0];
  if (
    rows.length !== 1 ||
    !job ||
    job.status !== "running" ||
    job.locked_by !== ctx.job.locked_by ||
    !job.locked_by ||
    !job.claim_acquired_at ||
    job.claim_acquired_at !== ctx.job.claim_acquired_at
  )
    throw new DemoIsolationError();
  const original = demoInputFromJob(ctx.job),
    current = demoInputFromJob(job);
  if (JSON.stringify(original) !== JSON.stringify(current)) throw new DemoIsolationError();
  return assertDemoInbound(ctx.db, ctx.binding, current);
}
/** Corte final: limita também o destinatário e a sessão realmente enviados ao provider. */
export async function assertDemoTransport(input: {
  organizationId: string;
  sessionRef: string;
  to: string;
  kind: string;
}): Promise<void> {
  denyDemoWebAction();
  if (await assertDemoStaffDelivery(input.organizationId, undefined, input)) return;
  if (!demoInboundOnly()) return;
  const ctx = execution.getStore();
  if (!ctx || input.kind !== "text" || input.organizationId !== ctx.binding.organizationId)
    throw new DemoIsolationError();
  const bound = await assertCurrentDemoJob(ctx);
  if (input.sessionRef !== bound.sessionRef || input.to !== bound.recipient)
    throw new DemoIsolationError();
}
export function denyDemoAutomation(): void {
  denyDemoWebAction();
  if (demoInboundOnly()) throw new DemoIsolationError();
}
