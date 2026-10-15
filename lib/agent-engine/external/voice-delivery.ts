import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Queryable } from "../queue/queue";
import { currentExecutionJob, guardServiceEffect } from "@/lib/atendimento/fronteira-server";
import {
  assertSpeechAuthority,
  prepareSpeechArtifact,
  type SpeechConfig,
  type SpeechInput,
} from "./speech-artifact";

import { voiceReplySchema, type VoiceReply } from "./voice-contract";
export type { VoiceReply } from "./voice-contract";
const artifactSchema = z.strictObject({
  type: z.literal("audio"),
  media_storage_path: z.string().min(1),
  media_mime: z.literal("audio/ogg;codecs=opus"),
  media_size_bytes: z
    .number()
    .int()
    .positive()
    .max(2 * 1024 * 1024),
  audio_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  text_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  transcript: z.string().min(1).max(2000),
  request_id: z.uuid(),
});
type Artifact = z.infer<typeof artifactSchema>;
const deliverySchema = z.strictObject({
  state: z.enum(["reserved", "preparing", "ready", "attempted"]),
  voice: voiceReplySchema,
  artifact: artifactSchema.optional(),
});
/** Opt-in per channel. Modality is read from the durable, tenant-bound inbound, never the model. */
export async function resolveVoiceReply(
  db: Queryable,
  input: {
    organizationId: string;
    conversationId: string;
    inboundMessageId: string;
    language: string;
  },
): Promise<VoiceReply | undefined> {
  const { rows } = await db.query<{ type: string; mode: string | null }>(
    `select m.type, cs.metadata->>'voice_reply_mode' as mode
       from public.messages m
       join public.conversations c on c.id=m.conversation_id and c.organization_id=m.organization_id and c.contact_id=m.contact_id and c.channel_session_id=m.channel_session_id
       join public.channel_sessions cs on cs.id=c.channel_session_id and cs.organization_id=c.organization_id
      where m.organization_id=$1 and c.id=$2 and m.id=$3 and m.direction='inbound'`,
    [input.organizationId, input.conversationId, input.inboundMessageId],
  );
  if (rows.length !== 1) throw Error("voice_inbound_binding_denied");
  const row = rows[0]!;
  if (row.mode === null || row.mode === "text") return undefined;
  if (row.mode !== "match_input") throw Error("voice_reply_policy_invalid");
  if (row.type !== "audio") return undefined;
  const language =
    input.language === "malayalam" || input.language === "malayalam_english_mixed"
      ? "ml"
      : input.language === "english"
        ? "en"
        : null;
  if (!language) throw Error("voice_reply_language_unsupported");
  return { inboundMessageId: input.inboundMessageId, language };
}

const delivery = new AsyncLocalStorage<{
  org: string;
  conversation: string;
  job: string;
  artifact: Artifact;
  db: Queryable;
  input: SpeechInput;
  ttl: number;
}>();
/** Only canonical, reserved AI delivery establishes this server-side capability. */
export function preparedVoiceMatches(org: string, conversation?: string, path?: string): boolean {
  const scope = delivery.getStore();
  const job = currentExecutionJob();
  return (
    !!scope &&
    !!job &&
    job.kind === "inbound_turn" &&
    job.id === scope.job &&
    job.organization_id === org &&
    scope.org === org &&
    (!conversation || scope.conversation === conversation) &&
    (!path || scope.artifact.media_storage_path === path)
  );
}

/** Called again by the canonical before-transport guard; no-op for ordinary sends. */
export async function guardPreparedVoiceEffect(): Promise<void> {
  const scope = delivery.getStore();
  if (!scope) return;
  if (!preparedVoiceMatches(scope.org, scope.conversation, scope.artifact.media_storage_path))
    throw Error("voice_execution_denied");
  await assertSpeechAuthority(scope.db, scope.input, scope.ttl);
}

/** CAS state changes serialize preparation and fence all uncertain sends. No automatic lease stealing. */
export async function deliverVoice<T>(
  db: Queryable,
  supabase: SupabaseClient,
  input: SpeechInput,
  voiceInput: VoiceReply,
  config: SpeechConfig & { allowlistTtlMs: number },
  send: (artifact: Artifact) => Promise<T>,
): Promise<T> {
  const voice = voiceReplySchema.parse(voiceInput);
  const job = currentExecutionJob();
  if (
    !job ||
    job.kind !== "inbound_turn" ||
    job.organization_id !== input.organization_id ||
    job.payload.inbound_message_id !== voice.inboundMessageId ||
    job.payload.conversation_id !== input.conversation_id ||
    !job.locked_by ||
    !job.claim_acquired_at
  )
    throw Error("voice_execution_denied");
  await guardServiceEffect();
  const { rows } = await db.query<{ voice_delivery: unknown }>(
    `select l.voice_delivery from public.send_ledger l
      join public.job_queue j on j.id=l.job_id and j.organization_id=l.organization_id
      join public.messages m on m.id=$5 and m.organization_id=j.organization_id and m.contact_id=j.contact_id
      join public.conversations c on c.id=m.conversation_id and c.organization_id=m.organization_id and c.contact_id=m.contact_id and c.channel_session_id=m.channel_session_id
     where l.id=$1 and l.organization_id=$2 and l.job_id=$3 and l.body_hash=$4 and l.status='requested'
       and m.direction='inbound' and m.type='audio' and c.id=$6 and c.id::text=j.payload->>'conversation_id'
       and m.id::text=j.payload->>'inbound_message_id' and j.status='running' and j.kind='inbound_turn'
       and j.locked_by=$7 and j.locked_at=$8::timestamptz
       and exists(select 1 from public.channel_sessions cs where cs.id=c.channel_session_id and cs.organization_id=c.organization_id
         and cs.metadata->>'voice_reply_mode'='match_input')`,
    [
      input.request_id,
      input.organization_id,
      job.id,
      createHash("sha256").update(input.text).digest("hex"),
      voice.inboundMessageId,
      input.conversation_id,
      job.locked_by,
      job.claim_acquired_at,
    ],
  );
  if (rows.length !== 1) throw Error("voice_ledger_binding_denied");
  let state = deliverySchema.parse(rows[0]!.voice_delivery);
  if (
    state.voice.inboundMessageId !== voice.inboundMessageId ||
    state.voice.language !== voice.language
  )
    throw Error("voice_intent_changed");
  const transition = async (next: typeof state) => {
    const result = await db.query(
      `update public.send_ledger set voice_delivery=$4::jsonb, updated_at=now()
        where id=$1 and organization_id=$2 and job_id=$3 and status='requested' and voice_delivery=$5::jsonb
          and exists(select 1 from public.job_queue j where j.id=$3 and j.organization_id=$2
            and j.status='running' and j.locked_by=$6 and j.locked_at=$7::timestamptz)
          and exists(select 1 from public.conversations c join public.channel_sessions cs
            on cs.id=c.channel_session_id and cs.organization_id=c.organization_id
            where c.organization_id=$2 and c.id=$8 and cs.metadata->>'voice_reply_mode'='match_input')
        returning id`,
      [
        input.request_id,
        input.organization_id,
        job.id,
        JSON.stringify(next),
        JSON.stringify(state),
        job.locked_by,
        job.claim_acquired_at,
        input.conversation_id,
      ],
    );
    if (result.rows.length !== 1) throw Error("voice_delivery_concurrent_or_uncertain");
    state = next;
  };
  if (state.state === "reserved") {
    await transition({ ...state, state: "preparing" });
    const artifact = await prepareSpeechArtifact(db, supabase, input, config);
    await transition({ ...state, state: "ready", artifact });
  } else if (state.state !== "ready") {
    throw Error("voice_delivery_uncertain"); // crash/timeout: operator reconciliation, never a blind resend
  }
  const artifact = artifactSchema.parse(state.artifact);
  const path = `${input.organization_id}/${input.conversation_id}/${input.request_id}.ogg`;
  if (
    artifact.media_storage_path !== path ||
    artifact.request_id !== input.request_id ||
    artifact.transcript !== input.text ||
    artifact.text_sha256 !== createHash("sha256").update(input.text).digest("hex")
  )
    throw Error("voice_artifact_binding_denied");
  // Reuse only a ledger-bound object; a path alone is never evidence of ownership/content.
  const { data, error } = await supabase.storage.from("whatsapp-media").download(path);
  if (error || !data || data.size !== artifact.media_size_bytes)
    throw Error("voice_artifact_unavailable");
  const bytes = Buffer.from(await data.arrayBuffer());
  if (createHash("sha256").update(bytes).digest("hex") !== artifact.audio_sha256)
    throw Error("voice_artifact_digest_mismatch");
  await assertSpeechAuthority(db, input, config.allowlistTtlMs);
  // Fence BEFORE invoking the canonical handler, even if it queues/fails before transport.
  // A confirmed CRM receipt can reconcile this state; an ambiguous result cannot retry.
  await transition({ ...state, state: "attempted" });
  return delivery.run(
    {
      org: input.organization_id,
      conversation: input.conversation_id,
      job: job.id,
      artifact,
      db,
      input,
      ttl: config.allowlistTtlMs,
    },
    () => send(artifact),
  );
}
