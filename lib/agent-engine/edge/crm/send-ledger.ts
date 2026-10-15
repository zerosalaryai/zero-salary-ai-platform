import { ApiError } from "@/lib/api/types";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { reservedVoiceDelivery, type VoiceReply } from "../../external/voice-contract";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Queryable } from "../../queue/queue";

export type SendLedgerStatus = "requested" | "accepted" | "queued" | "vetoed" | "failed";
export type SendOutcome =
  | { kind: "sent"; idempotencyKey: string; crmMessageId: string }
  | {
      kind: "already_sent" | "queued" | "failed";
      idempotencyKey: string;
      crmMessageId: string | null;
    }
  | { kind: "blocked"; idempotencyKey: string };
type Intent = {
  tenantId: string;
  leadId: string | null;
  jobId: string;
  seq: number;
  body: string;
  acceptedResponse?: unknown;
  voice?: VoiceReply;
};
type Row = {
  id: string;
  status: SendLedgerStatus;
  crm_message_id: string | null;
  external_response?: unknown;
  body_hash?: string;
  voice_delivery?: unknown;
};
interface LedgerStore {
  create(input: Intent, hash: string): Promise<string>;
  find(input: Intent): Promise<Row | null>;
  rotate(input: Intent, hash: string): Promise<string>;
  /**
   * Substitui a resposta ligada a uma intenção ainda sem mensagem. A implementação
   * precisa fazer a prova de ausência e o update na mesma operação atômica.
   */
  rebindUnsent?(input: Intent, hash: string, key: string): Promise<boolean>;
  message(org: string, key: string): Promise<{ id: string; status: string; external_id?: string | null } | null>;
  update(
    org: string,
    key: string,
    status: SendLedgerStatus,
    id: string | null,
    error: string | null,
  ): Promise<void>;
}
/** Inline e daemon compartilham identidade (job,seq), reconciliação e mensagem.
 * Página/worker perdido não cria uma segunda intenção. queued é reavaliado pelo
 * handler com o MESMO id; somente sent/delivered/read confirmam entrega. */
export async function sendWithLedger(
  store: LedgerStore,
  input: Intent,
  send: (key: string, messageId: string) => Promise<{ id: string; status: string; external_id?: string | null }>,
): Promise<SendOutcome> {
  const hash = createHash("sha256").update(input.body).digest("hex");
  let key: string;
  let prior: Row | null = null;
  try {
    key = await store.create(input, hash);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "23505"))
      throw error;
    prior = await store.find(input);
    if (!prior) throw new Error("send_ledger_missing");
    key = prior.id;
    if (prior.status === "accepted")
      return { kind: "already_sent", idempotencyKey: key, crmMessageId: prior.crm_message_id };
    if (prior.status === "vetoed") return { kind: "blocked", idempotencyKey: key };
    if (prior.voice_delivery != null) {
      const frozen = prior.voice_delivery as { voice?: unknown };
      if (!input.voice || prior.body_hash !== hash || !isDeepStrictEqual(frozen.voice, input.voice) ||
          !isDeepStrictEqual(prior.external_response, input.acceptedResponse))
        throw new Error("voice_intent_changed");
      if (prior.status === "failed") throw new Error("voice_delivery_uncertain");
    } else if (input.voice) throw new Error("voice_intent_changed");
    if (prior.status === "failed") key = await store.rotate(input, hash);
  }
  const existing = await store.message(input.tenantId, key);

  // Uma resposta externa v2 já ligada só pode ser trocada quando não há mensagem
  // CRM e a ausência continua verdadeira no mesmo UPDATE. Se uma mensagem existe,
  // ela pode ter sido aceita pelo transporte: preserve a resposta anterior.
  if (
    prior?.status === "requested" &&
    prior.voice_delivery == null &&
    input.acceptedResponse !== undefined &&
    existing === null
  ) {
    const rebound = await store.rebindUnsent?.(input, hash, key);
    if (!rebound) throw new Error("send_ledger_external_response_rebind_ambiguous");
  }

  if (
    prior !== null &&
    input.acceptedResponse !== undefined &&
    (prior.status === "queued" ||
      (existing !== null && !["sent", "delivered", "read", "failed"].includes(existing.status)))
  ) {
    return {
      kind: "queued",
      idempotencyKey: key,
      crmMessageId: existing?.id ?? prior.crm_message_id,
    };
  }

  let message = existing;
  if (!message || message.status === "queued") {
    try {
      message = await send(key, existing?.id ?? key);
    } catch (error) {
      if (error instanceof ApiError && error.status === 403) {
        await store.update(input.tenantId, key, "vetoed", null, "handler 403");
        return { kind: "blocked", idempotencyKey: key };
      }
      throw error;
    }
  }
  if (input.voice && ["sent", "delivered", "read"].includes(message.status) && !message.external_id?.trim())
    throw new Error("voice_delivery_receipt_uncertain");
  const status: SendLedgerStatus = ["sent", "delivered", "read"].includes(message.status)
    ? "accepted"
    : message.status === "failed"
      ? "failed"
      : "queued";
  await store.update(
    input.tenantId,
    key,
    status,
    message.id,
    status === "failed" ? "handler marcou a mensagem como failed" : null,
  );
  return status === "accepted"
    ? { kind: "sent", idempotencyKey: key, crmMessageId: message.id }
    : { kind: status, idempotencyKey: key, crmMessageId: message.id };
}
/** Reconcilia um recibo já existente sem criar intenção nem chamar o canal.
 * Consumidores determinísticos consultam isto antes dos gates de um NOVO envio. */
export async function reconcileAcceptedSend(
  db: Queryable, input: { tenantId: string; jobId: string; seq: number },
): Promise<boolean> {
  const store = pgSendLedger(db);
  const prior = await store.find({ ...input, leadId: null, body: "" });
  if (!prior) return false;
  if (prior.status === "accepted") return true;
  const message = await store.message(input.tenantId, prior.id);
  if (!message || !["sent", "delivered", "read"].includes(message.status)) return false;
  await store.update(input.tenantId, prior.id, "accepted", message.id, null);
  return true;
}

/**
 * Recupera somente metadado ligado a uma intenção que o canal já aceitou.
 * `requested` também é reconciliado com `messages`: cobre o crash depois do
 * transporte e antes do update do ledger, sem uma segunda geração ou entrega.
 */
export async function loadAcceptedExternalResponse(
  db: Queryable,
  input: { tenantId: string; jobId: string },
): Promise<unknown | null> {
  const binding = await loadExternalResponseBinding(db, input);
  return binding?.kind === "accepted" ? binding.response : null;
}

export type ExternalResponseBinding =
  | { kind: "accepted"; response: unknown }
  | { kind: "pending"; response: unknown }
  | { kind: "replaceable"; response: unknown }
  | { kind: "prepared"; response: unknown };

/**
 * Consulta a resposta já ligada antes de gerar outra. Uma mensagem existente ou
 * um ledger queued é conservadoramente tratado como entrega em voo; só
 * requested sem mensagem, ou falha explícita, permite uma nova candidata.
 */
export async function loadExternalResponseBinding(
  db: Queryable,
  input: { tenantId: string; jobId: string },
): Promise<ExternalResponseBinding | null> {
  const { rows } = await db.query<{
    id: string;
    seq: number;
    status: SendLedgerStatus;
    crm_message_id: string | null;
    external_response: unknown;
    voice_delivery?: { state?: string } | null;
  }>(
    `select id, seq, status, crm_message_id, external_response, voice_delivery
       from send_ledger
      where organization_id = $1
        and job_id = $2
      order by (external_response is not null) desc, seq desc`,
    [input.tenantId, input.jobId],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.status === "accepted" && row.voice_delivery == null) return { kind: "accepted", response: row.external_response };

  const store = pgSendLedger(db);
  const message = await store.message(input.tenantId, row.id);
  if (message && ["sent", "delivered", "read"].includes(message.status) &&
      (row.voice_delivery == null || !!message.external_id?.trim())) {
    await store.update(input.tenantId, row.id, "accepted", message.id, null);
    return { kind: "accepted", response: row.external_response };
  }
  if (row.voice_delivery != null) {
    const resumable = row.status === "requested" && message === null &&
      ["reserved", "ready"].includes(row.voice_delivery.state ?? "");
    return { kind: resumable ? "prepared" : "pending", response: row.external_response };
  }
  if (row.status === "failed" || message?.status === "failed") {
    return { kind: "replaceable", response: row.external_response };
  }
  if (row.status === "queued" || message !== null) {
    return { kind: "pending", response: row.external_response };
  }

  // A resposta pode ter sido dividida em bolhas, com o metadado v2 somente na
  // última. Se qualquer bolha irmã já existe/foi aceita, regenerar a resposta
  // inteira misturaria candidatas. Segure o turno em vez de duplicar conteúdo.
  for (const sibling of rows.slice(1)) {
    if (
      sibling.status === "accepted" ||
      sibling.status === "queued" ||
      sibling.crm_message_id !== null
    ) {
      return { kind: "pending", response: row.external_response };
    }
    const siblingMessage = await store.message(input.tenantId, sibling.id);
    if (siblingMessage !== null && siblingMessage.status !== "failed") {
      return { kind: "pending", response: row.external_response };
    }
  }
  return { kind: "replaceable", response: row.external_response };
}
export function pgSendLedger(db: Queryable): LedgerStore {
  return {
    async create(i, hash) {
      const { rows } = await db.query<{ id: string }>(
        "insert into send_ledger (organization_id, contact_id, job_id, seq, body_hash, external_response, voice_delivery) values ($1, $2, $3, $4, $5, $6, $7) returning id",
        [
          i.tenantId,
          i.leadId,
          i.jobId,
          i.seq,
          hash,
          i.acceptedResponse === undefined ? null : JSON.stringify(i.acceptedResponse),
          i.voice ? JSON.stringify(reservedVoiceDelivery(i.voice)) : null,
        ],
      );
      if (!rows[0]) throw new Error("send_ledger_insert_missing");
      return rows[0].id;
    },
    async find(i) {
      const { rows } = await db.query<Row>(
        "select * from send_ledger where organization_id=$1 and job_id=$2 and seq=$3",
        [i.tenantId, i.jobId, i.seq],
      );
      return rows[0] ?? null;
    },
    async rotate(i, hash) {
      const { rows } = await db.query<{ id: string }>(
        "update send_ledger set id=gen_random_uuid(),status='requested',body_hash=$4,external_response=$5,crm_message_id=null,last_error=null,updated_at=now() where organization_id=$1 and job_id=$2 and seq=$3 and voice_delivery is null returning id",
        [
          i.tenantId,
          i.jobId,
          i.seq,
          hash,
          i.acceptedResponse === undefined ? null : JSON.stringify(i.acceptedResponse),
        ],
      );
      if (!rows[0]) throw new Error("send_ledger_rotation_missing");
      return rows[0].id;
    },
    async rebindUnsent(i, hash, key) {
      const { rows } = await db.query<{ id: string }>(
        `update send_ledger as ledger
            set body_hash=$4,
                external_response=$5,
                last_error=null,
                updated_at=now()
          where ledger.organization_id=$1
            and ledger.job_id=$2
            and ledger.seq=$3
            and ledger.id=$6
            and ledger.status='requested'
            and ledger.voice_delivery is null
            and ledger.crm_message_id is null
            and not exists (
              select 1
                from messages
               where organization_id=$1
                 and metadata->>'idempotency_key'=$6
            )
          returning ledger.id`,
        [
          i.tenantId,
          i.jobId,
          i.seq,
          hash,
          i.acceptedResponse === undefined ? null : JSON.stringify(i.acceptedResponse),
          key,
        ],
      );
      return rows.length === 1;
    },
    async message(org, key) {
      const { rows } = await db.query<{ id: string; status: string; external_id?: string | null }>(
        "select id,status,external_id from messages where organization_id=$1 and metadata->>'idempotency_key'=$2 limit 1",
        [org, key],
      );
      return rows[0] ?? null;
    },
    async update(org, key, status, id, error) {
      await db.query(
        "update send_ledger set status=$3,crm_message_id=coalesce($4,crm_message_id),last_error=$5,updated_at=now() where organization_id=$1 and id=$2",
        [org, key, status, id, error],
      );
    },
  };
}
export function supabaseSendLedger(db: SupabaseClient): LedgerStore {
  return {
    async create(i, hash) {
      const { data, error } = await db
        .from("send_ledger")
        .insert({
          organization_id: i.tenantId,
          contact_id: i.leadId,
          job_id: i.jobId,
          seq: i.seq,
          body_hash: hash,
          external_response: i.acceptedResponse ?? null,
        } as never)
        .select("id")
        .single();
      if (error) throw error;
      return data.id;
    },
    async find(i) {
      const { data, error } = await db
        .from("send_ledger")
        .select("id,status,crm_message_id")
        .eq("organization_id", i.tenantId)
        .eq("job_id", i.jobId)
        .eq("seq", i.seq)
        .maybeSingle();
      if (error) throw error;
      return data as Row | null;
    },
    async rotate(i, hash) {
      const { data, error } = await db
        .from("send_ledger")
        .update({
          id: crypto.randomUUID(),
          status: "requested",
          body_hash: hash,
          external_response: i.acceptedResponse ?? null,
          crm_message_id: null,
          last_error: null,
          updated_at: new Date().toISOString(),
        } as never)
        .eq("organization_id", i.tenantId)
        .eq("job_id", i.jobId)
        .eq("seq", i.seq)
        .select("id")
        .single();
      if (error) throw error;
      return data.id;
    },
    // PostgREST não oferece aqui a prova atômica cross-table exigida para
    // substituir metadado. Falha fechada; o runtime do agente usa o store PG.
    async rebindUnsent() {
      return false;
    },
    async message(org, key) {
      const { data, error } = await db
        .from("messages")
        .select("id,status")
        .eq("organization_id", org)
        .eq("metadata->>idempotency_key", key)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
    async update(org, key, status, id, errorText) {
      const { error } = await db
        .from("send_ledger")
        .update({
          status,
          ...(id ? { crm_message_id: id } : {}),
          last_error: errorText,
          updated_at: new Date().toISOString(),
        })
        .eq("organization_id", org)
        .eq("id", key);
      if (error) throw error;
    },
  };
}
/** Resultado do turno sem importar runtime/env; ausência de envio é terminal explícito. */
export async function resultadoDoEnvioDoFollowup(
  db: Queryable,
  org: string,
  job: string,
): Promise<{ kind: "sent" } | { kind: "skipped"; reason: string }> {
  const { rows } = await db.query<{ status: string }>(
    "select status from send_ledger where organization_id=$1 and job_id=$2",
    [org, job],
  );
  if (!rows.length)
    return {
      kind: "skipped",
      reason: "O assistente concluiu este passo sem enviar uma mensagem. Revise o próximo passo.",
    };
  if (rows.every((row) => row.status === "vetoed"))
    return { kind: "skipped", reason: "O envio foi recusado pelas regras do atendimento." };
  if (rows.some((row) => row.status !== "accepted")) throw new Error("followup_message_not_sent");
  return { kind: "sent" };
}
