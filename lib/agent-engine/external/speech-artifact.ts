import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Queryable } from "../queue/queue";
import { currentExecutionJob, guardServiceEffect } from "@/lib/atendimento/fronteira-server";
import { pythonAgentSignature } from "./python-agent-client";
import { decidirElegibilidadeDaConversa } from "@/lib/ai/elegibilidade/consulta-pg";
import { storagePathFor } from "@/lib/messaging/media/types";

const MIME = "audio/ogg;codecs=opus";
const MAX_AUDIO = 2 * 1024 * 1024;
const inputSchema = z.strictObject({
  request_id: z.uuid(),
  organization_id: z.uuid(),
  conversation_id: z.uuid(),
  text: z
    .string()
    .min(1)
    .max(2000)
    .refine((s) => s.trim().length > 0),
  language: z.enum(["ml", "en"]),
});
export type SpeechInput = z.infer<typeof inputSchema>;
export interface SpeechConfig {
  baseUrl: string;
  secret: string;
  fetch?: typeof fetch;
  now?: () => Date;
}

/** Bounded response-only client. Configuration is server-owned, never request input. */
export async function renderSpeech(input: SpeechInput, config: SpeechConfig): Promise<Buffer> {
  const value = inputSchema.parse(input);
  const endpoint = new URL(config.baseUrl);
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !["", "/"].includes(endpoint.pathname) ||
    !config.secret.trim()
  )
    throw Error("speech_configuration_invalid");
  endpoint.pathname = "/internal/speech";
  const digest = createHash("sha256").update(value.text).digest("hex");
  const body = JSON.stringify({ purpose: "speech", ...value, text_sha256: digest });
  const timestamp = Math.floor((config.now?.() ?? new Date()).getTime() / 1000).toString();
  const response = await (config.fetch ?? fetch)(endpoint, {
    method: "POST",
    redirect: "error",
    signal: AbortSignal.timeout(65000),
    headers: {
      "Content-Type": "application/json",
      "X-ZSAI-Request-Id": value.request_id,
      "X-ZSAI-Timestamp": timestamp,
      "X-ZSAI-Signature": pythonAgentSignature(config.secret, timestamp, value.request_id, body),
    },
    body,
  });
  if (!response.ok) throw Error(`speech_http_${response.status}`);
  if (
    response.headers.get("content-type") !== MIME ||
    response.headers.get("x-zsai-request-id") !== value.request_id ||
    response.headers.get("x-zsai-organization-id") !== value.organization_id ||
    response.headers.get("x-zsai-text-sha256") !== digest ||
    !response.body
  )
    throw Error("speech_response_invalid");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value: bytes } = await reader.read();
    if (done) break;
    size += bytes.byteLength;
    if (size > MAX_AUDIO) {
      await reader.cancel();
      throw Error("speech_response_too_large");
    }
    chunks.push(bytes);
  }
  const audio = Buffer.concat(chunks);
  if (
    audio.subarray(0, 4).toString() !== "OggS" ||
    !audio.subarray(0, 128).includes(Buffer.from("OpusHead")) ||
    response.headers.get("x-zsai-audio-sha256") !== createHash("sha256").update(audio).digest("hex")
  )
    throw Error("speech_audio_invalid");
  return audio;
}

/** Revalidate STOP, human authority, tenant binding and the current claim at every voice effect. */
export async function assertSpeechAuthority(
  db: Queryable,
  input: SpeechInput,
  allowlistTtlMs: number,
): Promise<void> {
  const value = inputSchema.parse(input);
  if (!Number.isFinite(allowlistTtlMs) || allowlistTtlMs <= 0)
    throw Error("speech_configuration_invalid");
  const job = currentExecutionJob();
  if (
    !job ||
    job.kind !== "inbound_turn" ||
    job.organization_id !== value.organization_id ||
    job.payload.conversation_id !== value.conversation_id ||
    typeof job.payload.inbound_message_id !== "string" ||
    !job.locked_by ||
    !job.claim_acquired_at
  )
    throw Error("speech_context_denied");
  const textHash = createHash("sha256").update(value.text).digest("hex");
  await guardServiceEffect();
  const eligibility = await decidirElegibilidadeDaConversa(db, {
    organizationId: value.organization_id,
    conversationId: value.conversation_id,
    agora: new Date(),
    ttlMs: allowlistTtlMs,
  });
  if (!eligibility?.permite) throw Error("speech_eligibility_denied");
  const { rows } = await db.query(
    `select l.id from send_ledger l
      join job_queue j on j.id=l.job_id and j.organization_id=l.organization_id and j.contact_id=l.contact_id
      join conversations c on c.id::text=j.payload->>'conversation_id' and c.organization_id=j.organization_id and c.contact_id=j.contact_id
      join contacts ct on ct.id=c.contact_id and ct.organization_id=c.organization_id
      join channel_sessions cs on cs.id=c.channel_session_id and cs.organization_id=c.organization_id
      where l.id=$1 and l.organization_id=$2 and l.job_id=$3 and l.body_hash=$4 and l.status='requested'
        and j.payload->>'inbound_message_id'=$8
        and l.voice_delivery#>>'{voice,inboundMessageId}'=$8
        and j.status='running' and j.locked_by=$6 and j.locked_at=$7::timestamptz and c.id=$5 and c.status not in ('closed','resolved','archived')
        and cs.metadata->>'voice_reply_mode'='match_input'
        and ct.force_human is false and ct.is_blocked is false and ct.is_anonymized is false and ct.is_merged_into is null
        and c.assigned_to_user_id is null and c.assignee_kind is distinct from 'human'`,
    [
      value.request_id,
      value.organization_id,
      job.id,
      textHash,
      value.conversation_id,
      job.locked_by,
      job.claim_acquired_at,
      job.payload.inbound_message_id,
    ],
  );
  if (rows.length !== 1) throw Error("speech_scope_denied");
}

/** Preparation only: requires an already reserved canonical send intent; never sends. */
export async function prepareSpeechArtifact(
  db: Queryable,
  supabase: SupabaseClient,
  input: SpeechInput,
  config: SpeechConfig & { allowlistTtlMs: number },
) {
  const value = inputSchema.parse(input);
  if (!Number.isFinite(config.allowlistTtlMs) || config.allowlistTtlMs <= 0)
    throw Error("speech_configuration_invalid");
  const textHash = createHash("sha256").update(value.text).digest("hex");
  const authorize = () => assertSpeechAuthority(db, value, config.allowlistTtlMs);
  await authorize();
  const audio = await renderSpeech(value, config);
  await authorize(); // A takeover or boundary change during TTS must prevent storage.
  const storagePath = storagePathFor(
    value.organization_id,
    value.conversation_id,
    value.request_id,
    MIME,
  );
  const { error } = await supabase.storage
    .from("whatsapp-media")
    .upload(storagePath, audio, { contentType: MIME, upsert: false });
  if (error) throw Error("speech_artifact_storage_failed"); // Never overwrite or adopt an unverified existing object.
  return {
    type: "audio" as const,
    media_storage_path: storagePath,
    media_mime: "audio/ogg;codecs=opus" as const,
    media_size_bytes: audio.length,
    audio_sha256: createHash("sha256").update(audio).digest("hex"),
    text_sha256: textHash,
    transcript: value.text,
    request_id: value.request_id,
  };
}

export type SpeechArtifact = Awaited<ReturnType<typeof prepareSpeechArtifact>>;
