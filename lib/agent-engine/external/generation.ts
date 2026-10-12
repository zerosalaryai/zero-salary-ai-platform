import { createHash } from 'node:crypto';

import type { Logger } from '../obs/logger';
import type { ReplyLanguage } from '../agent/reply-language';
import {
  EXTERNAL_AGENT_HISTORY_LIMIT,
  EXTERNAL_AGENT_SCHEMA_VERSION,
  externalAgentTurnRequestV2Schema,
  type ExternalAgentTurnRequest,
  type ExternalAgentTurnRequestV2,
  type ExternalAgentReplyV2,
  type ExternalAgentTurnResponse,
  type ExternalReplyLanguage,
} from './contracts';
import {
  callPythonAgent,
  PythonAgentClientError,
  serializePythonAgentRequest,
  type PythonAgentClientConfig,
} from './python-agent-client';

const LANGUAGE_TO_EXTERNAL: Record<Exclude<ReplyLanguage, 'undetermined'>, ExternalReplyLanguage> = {
  english: 'en',
  portuguese: 'pt',
  malayalam: 'ml',
  arabic: 'ar',
  hindi: 'hi',
  tamil: 'ta',
  malayalam_english_mixed: 'ml-en',
};

const EXTERNAL_GENERATION_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

const RETRY_INSTRUCTION = {
  language_mismatch:
    'Mandatory correction: rewrite the previous draft in the requested customer reply language. Preserve the answer meaning and return only the corrected customer-facing reply.',
  internal_vocabulary_leak:
    'Mandatory correction: rewrite the previous draft as customer-safe language. Remove internal roles, workflow labels, tool or database terms, guardrail/error names, and implementation vocabulary. Preserve the answer meaning and requested reply language. Return only the corrected customer-facing reply.',
} as const;

export function externalGenerationRequestId(rootRequestId: string, attempt: 1 | 2): string {
  const namespace = Buffer.from(EXTERNAL_GENERATION_NAMESPACE.replaceAll('-', ''), 'hex');
  const bytes = createHash('sha1')
    .update(namespace)
    .update(`zsai-agent-turn:${rootRequestId}:generation-attempt:${attempt}`, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export type AgentRuntimeMode = 'native' | 'python';

export interface ExternalGenerationConfig extends PythonAgentClientConfig {
  runtime: AgentRuntimeMode;
  call?: typeof callPythonAgent;
}

export function shouldUseExternalRuntime(input: {
  runtime: AgentRuntimeMode | undefined;
  jobKind: string;
  hasPublishedAgent: boolean;
  preview: boolean;
}): boolean {
  return (
    input.runtime === 'python' &&
    input.jobKind === 'inbound_turn' &&
    input.hasPublishedAgent &&
    !input.preview
  );
}

export interface ExternalRequestSource {
  requestId: string;
  organizationId: string;
  channelSessionId: string;
  conversationId: string;
  contactId: string;
  agentId: string;
  agentVersionId: string;
  instructions: string;
  messageId: string;
  messageText: string;
  replyLanguage: ReplyLanguage;
  history: ReadonlyArray<{
    direction: 'inbound' | 'outbound';
    body: string;
    sent_at: string;
  }>;
  contact: { name: string | null; tags: readonly string[] };
  lead: { stage: string | null; nextAction: string | null };
  previousSummary: string | null;
}

export function externalReplyLanguage(language: ReplyLanguage): ExternalReplyLanguage {
  // O detector do CRM preserva `undetermined` para mensagens curtas ("ok", nomes,
  // números). A Stage 1A não aceita esse valor. `en` é apenas a instrução de geração;
  // o gate final continua usando o resultado original do CRM e não é afrouxado.
  return language === 'undetermined' ? 'en' : LANGUAGE_TO_EXTERNAL[language];
}

export function buildExternalAgentTurnRequest(
  source: ExternalRequestSource,
  retry: ExternalAgentTurnRequestV2['retry'] = {
    attempt: 1,
    reason: 'initial',
    rejected_draft: null,
  },
): ExternalAgentTurnRequestV2 {
  if (retry.attempt !== 1 && retry.attempt !== 2) {
    throw new Error('external_generation_attempt_invalid');
  }
  const request = externalAgentTurnRequestV2Schema.parse({
    schema_version: EXTERNAL_AGENT_SCHEMA_VERSION,
    request_id: externalGenerationRequestId(source.requestId, retry.attempt),
    organization_id: source.organizationId,
    channel_session_id: source.channelSessionId,
    conversation_id: source.conversationId,
    contact_id: source.contactId,
    agent: {
      id: source.agentId,
      version_id: source.agentVersionId,
      instructions:
        retry.reason === 'initial'
          ? source.instructions
          : `${RETRY_INSTRUCTION[retry.reason]}\n\n${source.instructions}`,
    },
    input: {
      message_id: source.messageId,
      type: 'text',
      text: source.messageText,
      reply_language: externalReplyLanguage(source.replyLanguage),
    },
    history: source.history
      .filter((message) => message.body.trim() !== '')
      .slice(-EXTERNAL_AGENT_HISTORY_LIMIT)
      .map((message) => ({
        role: message.direction === 'inbound' ? 'user' : 'assistant',
        text: message.body,
        sent_at: message.sent_at,
      })),
    context: {
      contact: {
        name: source.contact.name,
        tags: [...source.contact.tags].slice(0, 50),
      },
      lead: { stage: source.lead.stage, next_action: source.lead.nextAction },
      previous_summary: source.previousSummary,
    },
    retry,
  });
  serializePythonAgentRequest(request);
  return request;
}

export type CustomerReplyExecutionResult =
  | { ok: true; status: string; message_id?: string }
  | { ok: false; error: { code: string; message: string } };

export type ExternalGenerationOutcome =
  | { kind: 'reply_processed'; traceId: string; acceptedResponse?: ExternalAgentReplyV2 }
  | { kind: 'handoff'; traceId?: string; reason: string }
  | { kind: 'no_reply'; traceId: string; reason: string };

export async function executeExternalGeneration(args: {
  source: ExternalRequestSource;
  config: ExternalGenerationConfig;
  log: Logger;
  sendReply: (
    text: string,
    acceptedResponse?: ExternalAgentReplyV2,
  ) => Promise<CustomerReplyExecutionResult>;
  handoff: (reason: string) => Promise<void>;
}): Promise<ExternalGenerationOutcome> {
  const call = args.config.call ?? callPythonAgent;

  const buildRequest = async (
    retry?: ExternalAgentTurnRequestV2['retry'],
  ): Promise<ExternalAgentTurnRequestV2 | null> => {
    try {
      return buildExternalAgentTurnRequest(args.source, retry);
    } catch (error) {
      const known = error instanceof PythonAgentClientError ? error : null;
      if (known?.category !== 'request_too_large') throw error;
      args.log.warn('pedido ao runtime externo excedeu o contrato antes da chamada', {
        external_runtime: 'python',
        error_category: known.category,
        retryable: false,
      });
      await args.handoff(`external_${known.category}`);
      return null;
    }
  };

  const request = await buildRequest();
  if (request === null) return { kind: 'handoff', reason: 'request_too_large' };

  const invoke = async (body: ExternalAgentTurnRequest): Promise<ExternalAgentTurnResponse> => {
    const startedAt = performance.now();
    try {
      const response = await call(body, args.config);
      args.log.info('runtime externo concluiu a geração', {
        external_runtime: 'python',
        request_id: body.request_id,
        trace_id: response.trace_id,
        status: response.status,
        provider: response.usage?.provider,
        model: response.usage?.model,
        latency_ms: Math.round(performance.now() - startedAt),
      });
      return response;
    } catch (error) {
      const known = error instanceof PythonAgentClientError ? error : null;
      args.log.warn('runtime externo falhou antes do ledger de envio', {
        external_runtime: 'python',
        request_id: body.request_id,
        error_category: known?.category ?? 'unknown',
        retryable: known?.retryable ?? true,
        latency_ms: Math.round(performance.now() - startedAt),
      });
      if (known?.retryable ?? true) throw error;
      await args.handoff(`external_${known?.category ?? 'unknown'}`);
      return Promise.reject(new ExternalTerminalHandledError(known?.category ?? 'unknown'));
    }
  };

  let response: ExternalAgentTurnResponse;
  try {
    response = await invoke(request);
  } catch (error) {
    if (error instanceof ExternalTerminalHandledError) {
      return { kind: 'handoff', reason: error.category };
    }
    throw error;
  }

  if (response.status === 'handoff') {
    await args.handoff(`external_${response.handoff.reason_code}`);
    return { kind: 'handoff', traceId: response.trace_id, reason: response.handoff.reason_code };
  }
  if (response.status === 'no_reply') {
    return {
      kind: 'no_reply',
      traceId: response.trace_id,
      reason: response.no_reply.reason_code,
    };
  }

  const firstV2 = response.schema_version === '2' ? response : undefined;
  const first = firstV2
    ? await args.sendReply(response.reply.text, firstV2)
    : await args.sendReply(response.reply.text);
  const correctionReason =
    first.ok === false && first.error.code === 'reply_language_mismatch'
      ? 'language_mismatch'
      : first.ok === false && first.error.code === 'internal_vocabulary_leak'
        ? 'internal_vocabulary_leak'
        : null;
  if (correctionReason === null) {
    return {
      kind: 'reply_processed',
      traceId: response.trace_id,
      ...(first.ok && firstV2 ? { acceptedResponse: firstV2 } : {}),
    };
  }
  args.log.info('runtime externo reprocessará resposta vetada', {
    external_runtime: 'python',
    correction_reason: correctionReason,
    attempt: 2,
  });

  const correctionRequest = await buildRequest({
    attempt: 2,
    reason: correctionReason,
    rejected_draft: response.reply.text,
  });
  if (correctionRequest === null) return { kind: 'handoff', reason: 'request_too_large' };
  try {
    const correction = await invoke(correctionRequest);
    if (correction.status !== 'reply') {
      const retryKind =
        correctionReason === 'language_mismatch' ? 'language' : 'internal_vocabulary';
      await args.handoff(`external_${retryKind}_retry_${correction.status}`);
      return {
        kind: 'handoff',
        traceId: correction.trace_id,
        reason: `${retryKind}_retry_${correction.status}`,
      };
    }
    const correctionV2 = correction.schema_version === '2' ? correction : undefined;
    const second = correctionV2
      ? await args.sendReply(correction.reply.text, correctionV2)
      : await args.sendReply(correction.reply.text);
    if (second.ok === false) {
      await args.handoff(`external_${second.error.code}`);
      return {
        kind: 'handoff',
        traceId: correction.trace_id,
        reason: second.error.code,
      };
    }
    return {
      kind: 'reply_processed',
      traceId: correction.trace_id,
      ...(correctionV2 ? { acceptedResponse: correctionV2 } : {}),
    };
  } catch (error) {
    if (error instanceof ExternalTerminalHandledError) {
      return { kind: 'handoff', reason: error.category };
    }
    throw error;
  }
}

class ExternalTerminalHandledError extends Error {
  constructor(readonly category: string) {
    super(category);
  }
}
