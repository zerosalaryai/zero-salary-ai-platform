import type pg from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";

import { patchContactHandler } from "@/app/api/v1/contacts/_handler";
import { getLeadHandler, updateLeadHandler } from "@/app/api/v1/leads/_handler";
import { resolveActiveLeadForContact, type LeadCandidate } from "@/lib/leads/active-lead";
import {
  AI_QUALIFICATION_FIELD,
  hasQualificationFacts,
  mergeAiQualification,
  type CapturedLeadFacts,
} from "@/lib/leads/ai-qualification";

function normalized(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

/**
 * Nome canônico é a única captura que escreve no contato, por isso exige uma
 * evidência literal e uma declaração em primeira pessoa. Um nome inferido do
 * pushName, da assinatura ou da resposta do agente continua passando pela fila
 * de propostas existente — ele nunca chega por esta função.
 */
export function verifiedSelfReportedName(
  fact: CapturedLeadFacts["explicit_name"],
  customerMessages: string[],
): string | null {
  if (!fact) return null;

  const evidence = normalized(fact.evidence);
  const source = customerMessages.find((message) => normalized(message).includes(evidence));
  if (!source) return null;

  const declaration = fact.evidence.match(
    /(?:\bmy\s+name\s+is\b|\bcall\s+me\b|എന്റെ\s+പേര്)\s+([^,.!?;:\n]{2,120})/iu,
  );
  if (!declaration?.[1]) return null;

  const declared = normalized(declaration[1]);
  const candidate = normalized(fact.value);
  if (declared !== candidate) return null;
  return fact.value.trim();
}

export interface PersistStructuredLeadCaptureInput {
  pool: pg.Pool;
  supabase: SupabaseClient;
  organizationId: string;
  contactId: string;
  jobId: string;
  agentId?: string | null;
  customerMessages: string[];
  facts: CapturedLeadFacts;
}

/**
 * Persiste o fechamento obrigatório nas fontes canônicas já existentes.
 * Toda consulta com service role leva `organization_id`; nenhum dado de canal
 * (`display_name`) participa do patch do contato.
 */
export async function persistStructuredLeadCapture(
  input: PersistStructuredLeadCaptureInput,
): Promise<{ nameUpdated: boolean; qualificationLeadId: string | null }> {
  const ctx = {
    organization_id: input.organizationId,
    requestId: input.jobId,
    actor: {
      type: "ai_agent" as const,
      id: input.jobId,
      role: "agent",
      ...(input.agentId ? { agent_id: input.agentId } : {}),
    },
  };

  let nameUpdated = false;
  const canonicalName = verifiedSelfReportedName(input.facts.explicit_name, input.customerMessages);
  if (canonicalName) {
    const { data: contact, error } = await input.supabase
      .from("contacts")
      .select("name")
      .eq("organization_id", input.organizationId)
      .eq("id", input.contactId)
      .maybeSingle();
    if (error) throw new Error(`structured_capture_contact_read_failed: ${error.message}`);
    if (contact && normalized(String(contact.name ?? "")) !== normalized(canonicalName)) {
      // Deliberadamente SÓ `name`: o pushName continua em `display_name`.
      await patchContactHandler(input.supabase, ctx, input.contactId, { name: canonicalName });
      nameUpdated = true;
    }
  }

  if (!hasQualificationFacts(input.facts)) {
    return { nameUpdated, qualificationLeadId: null };
  }

  const { rows: candidates } = await input.pool.query<LeadCandidate>(
    `select id, organization_id, pipeline_id, status, last_activity_at, created_at
       from crm_leads
      where organization_id = $1 and contact_id = $2`,
    [input.organizationId, input.contactId],
  );
  const { rows: defaults } = await input.pool.query<{ id: string }>(
    `select id from crm_pipelines
      where organization_id = $1 and is_default = true and is_archived = false
      limit 1`,
    [input.organizationId],
  );
  const target = resolveActiveLeadForContact(candidates, {
    defaultPipelineId: defaults[0]?.id ?? null,
  });

  if (!target.routed) {
    await input.pool.query(
      `insert into event_log (organization_id, event_type, entity_kind, entity_id, payload, metadata)
       values ($1, 'agent.structured_capture_unrouted', 'contact', $2, $3, $4)`,
      [
        input.organizationId,
        input.contactId,
        JSON.stringify({ reason: target.reason, candidate_lead_ids: target.candidateIds }),
        JSON.stringify({ source_module: "agent_checkpoint", job_id: input.jobId }),
      ],
    );
    return { nameUpdated, qualificationLeadId: null };
  }

  const lead = await getLeadHandler(input.supabase, ctx, target.leadId);
  const customFields =
    lead.custom_fields &&
    typeof lead.custom_fields === "object" &&
    !Array.isArray(lead.custom_fields)
      ? (lead.custom_fields as Record<string, unknown>)
      : {};
  const merged = mergeAiQualification(customFields[AI_QUALIFICATION_FIELD], input.facts);
  if (JSON.stringify(customFields[AI_QUALIFICATION_FIELD] ?? {}) !== JSON.stringify(merged)) {
    await updateLeadHandler(input.supabase, ctx, target.leadId, {
      custom_fields: { [AI_QUALIFICATION_FIELD]: merged },
    });
  }

  return { nameUpdated, qualificationLeadId: target.leadId };
}
