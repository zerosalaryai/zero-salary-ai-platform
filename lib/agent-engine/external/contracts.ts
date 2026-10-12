import { z } from 'zod';
import { checkpointCoreSchema } from '../agent/checkpoint-content';

export const EXTERNAL_AGENT_SCHEMA_VERSION_V1 = '1' as const;
export const EXTERNAL_AGENT_SCHEMA_VERSION = '2' as const;
export const EXTERNAL_AGENT_HISTORY_LIMIT = 20;
export const EXTERNAL_AGENT_CONTEXT_TEXT_LIMIT = 4_000;

export const externalReplyLanguageSchema = z.enum(['en', 'ml', 'ar', 'hi', 'ta', 'pt', 'ml-en']);

const opaqueIdSchema = z.string().uuid();
const boundedText = (max: number) => z.string().trim().min(1).max(max);

const requestShape = {
  request_id: opaqueIdSchema,
  organization_id: opaqueIdSchema,
  channel_session_id: opaqueIdSchema,
  conversation_id: opaqueIdSchema,
  contact_id: opaqueIdSchema,
  agent: z.strictObject({
    id: opaqueIdSchema,
    version_id: opaqueIdSchema,
    instructions: boundedText(80_000),
  }),
  input: z.strictObject({
    message_id: opaqueIdSchema,
    type: z.literal('text'),
    text: boundedText(20_000),
    reply_language: externalReplyLanguageSchema,
  }),
  history: z
    .array(
      z.strictObject({
        role: z.enum(['user', 'assistant']),
        text: boundedText(20_000),
        sent_at: z.string().datetime({ offset: true }),
      }),
    )
    .max(EXTERNAL_AGENT_HISTORY_LIMIT),
  context: z.strictObject({
    contact: z.strictObject({
      name: z.string().trim().max(300).nullable(),
      tags: z.array(z.string().trim().min(1).max(100)).max(50),
    }),
    lead: z.strictObject({
      stage: z.string().trim().min(1).max(100).nullable(),
      next_action: z.string().trim().max(500).nullable(),
    }),
    previous_summary: z.string().trim().max(EXTERNAL_AGENT_CONTEXT_TEXT_LIMIT).nullable(),
  }),
};

const retryReasonSchema = z.enum(['initial', 'language_mismatch', 'internal_vocabulary_leak']);

export const externalAgentTurnRequestV1Schema = z.strictObject({
  schema_version: z.literal(EXTERNAL_AGENT_SCHEMA_VERSION_V1),
  ...requestShape,
  retry: z.strictObject({
    attempt: z.number().int().min(1).max(2),
    reason: retryReasonSchema,
  }),
});

export const externalAgentTurnRequestV2Schema = z
  .strictObject({
    schema_version: z.literal(EXTERNAL_AGENT_SCHEMA_VERSION),
    ...requestShape,
    retry: z.strictObject({
      attempt: z.union([z.literal(1), z.literal(2)]),
      reason: retryReasonSchema,
      rejected_draft: z.string().trim().min(1).max(20_000).nullable(),
    }),
  })
  .superRefine((request, ctx) => {
    const initial = request.retry.attempt === 1 && request.retry.reason === 'initial';
    const correction =
      request.retry.attempt === 2 &&
      request.retry.reason !== 'initial' &&
      request.retry.rejected_draft !== null;
    if (!initial && !correction) {
      ctx.addIssue({
        code: 'custom',
        path: ['retry'],
        message: 'retry must be an initial attempt or a correction with its rejected draft',
      });
    }
    if (initial && request.retry.rejected_draft !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['retry', 'rejected_draft'],
        message: 'initial attempt cannot include a rejected draft',
      });
    }
  });

export const externalAgentTurnRequestSchema = z.union([
  externalAgentTurnRequestV1Schema,
  externalAgentTurnRequestV2Schema,
]);

const usageSchema = z
  .strictObject({
    provider: z.string().trim().min(1).max(100).optional(),
    model: z.string().trim().min(1).max(200).optional(),
    input_tokens: z.number().int().nonnegative().nullable().optional(),
    output_tokens: z.number().int().nonnegative().nullable().optional(),
    total_tokens: z.number().int().nonnegative().nullable().optional(),
  })
  .optional();

const responseBase = {
  request_id: boundedText(200),
  trace_id: boundedText(200),
  usage: usageSchema,
};

const stage1AResponseBase = {
  ...responseBase,
  actions: z.array(z.never()).max(0),
};

export const SAFE_NO_REPLY_REASONS = ['duplicate_request', 'superseded_message'] as const;

const externalAgentTurnResponseV1Schema = z.discriminatedUnion('status', [
  z.strictObject({
    schema_version: z.literal(EXTERNAL_AGENT_SCHEMA_VERSION_V1),
    ...stage1AResponseBase,
    status: z.literal('reply'),
    reply: z.strictObject({ type: z.literal('text'), text: boundedText(20_000) }),
    handoff: z.null(),
  }),
  z.strictObject({
    schema_version: z.literal(EXTERNAL_AGENT_SCHEMA_VERSION_V1),
    ...stage1AResponseBase,
    status: z.literal('handoff'),
    reply: z.null(),
    handoff: z.strictObject({
      reason_code: boundedText(100),
      summary: z.string().trim().max(2_000).optional(),
    }),
  }),
  z.strictObject({
    schema_version: z.literal(EXTERNAL_AGENT_SCHEMA_VERSION_V1),
    ...responseBase,
    status: z.literal('no_reply'),
    no_reply: z.strictObject({ reason_code: z.enum(SAFE_NO_REPLY_REASONS) }),
  }),
]);

export const externalAgentTurnResponseV2Schema = z.discriminatedUnion('status', [
  z.strictObject({
    schema_version: z.literal(EXTERNAL_AGENT_SCHEMA_VERSION),
    ...stage1AResponseBase,
    status: z.literal('reply'),
    reply: z.strictObject({ type: z.literal('text'), text: boundedText(20_000) }),
    checkpoint: checkpointCoreSchema,
    handoff: z.null(),
  }),
  z.strictObject({
    schema_version: z.literal(EXTERNAL_AGENT_SCHEMA_VERSION),
    ...stage1AResponseBase,
    status: z.literal('handoff'),
    reply: z.null(),
    handoff: z.strictObject({
      reason_code: boundedText(100),
      summary: z.string().trim().max(2_000).optional(),
    }),
  }),
  z.strictObject({
    schema_version: z.literal(EXTERNAL_AGENT_SCHEMA_VERSION),
    ...responseBase,
    status: z.literal('no_reply'),
    no_reply: z.strictObject({ reason_code: z.enum(SAFE_NO_REPLY_REASONS) }),
  }),
]);

export const externalAgentTurnResponseSchema = z.union([
  externalAgentTurnResponseV1Schema,
  externalAgentTurnResponseV2Schema,
]);

export type ExternalAgentTurnRequest = z.infer<typeof externalAgentTurnRequestSchema>;
export type ExternalAgentTurnRequestV2 = z.infer<typeof externalAgentTurnRequestV2Schema>;
export type ExternalAgentTurnResponse = z.infer<typeof externalAgentTurnResponseSchema>;
export type ExternalAgentReplyV2 = Extract<
  z.infer<typeof externalAgentTurnResponseV2Schema>,
  { status: 'reply' }
>;
export type ExternalReplyLanguage = z.infer<typeof externalReplyLanguageSchema>;
