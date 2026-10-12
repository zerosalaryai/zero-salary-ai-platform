import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '../obs/logger';
import {
  buildExternalAgentTurnRequest,
  executeExternalGeneration,
  externalGenerationRequestId,
  shouldUseExternalRuntime,
  type ExternalRequestSource,
} from './generation';
import {
  PYTHON_AGENT_MAX_INSTRUCTIONS_CHARS,
  PYTHON_AGENT_MAX_TEXT_CHARS,
  PythonAgentClientError,
} from './python-agent-client';

const source: ExternalRequestSource = {
  requestId: 'job-stable',
  organizationId: '11000000-0000-4000-8000-000000000001',
  channelSessionId: '11000000-0000-4000-8000-000000000002',
  conversationId: '11000000-0000-4000-8000-000000000003',
  contactId: '11000000-0000-4000-8000-000000000004',
  agentId: '11000000-0000-4000-8000-000000000005',
  agentVersionId: '11000000-0000-4000-8000-000000000006',
  instructions: 'Published instructions',
  messageId: '11000000-0000-4000-8000-000000000007',
  messageText: 'مرحبا، أحتاج مساعدة',
  replyLanguage: 'arabic',
  history: [
    { direction: 'inbound', body: 'older', sent_at: '2026-09-25T01:00:00+00:00' },
    { direction: 'outbound', body: 'previous reply', sent_at: '2026-09-25T01:00:30+00:00' },
    { direction: 'inbound', body: 'latest unanswered', sent_at: '2026-09-25T01:01:00+00:00' },
  ],
  contact: { name: 'Customer', tags: ['vip'] },
  lead: { stage: 'qualifying', nextAction: 'reply' },
  previousSummary: 'Prior summary',
};

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies Logger;
const response = (
  text: string,
  requestId = externalGenerationRequestId(source.requestId, 1),
  traceId = 'trace-1',
) => ({
  schema_version: '1' as const,
  request_id: requestId,
  trace_id: traceId,
  status: 'reply' as const,
  reply: { type: 'text' as const, text },
  handoff: null,
  actions: [],
  usage: {
    provider: 'sarvam',
    model: 'sarvam-105b-conversations',
    input_tokens: null,
    output_tokens: null,
  },
});

const checkpoint = {
  commitments: [],
  objections: ['Asked about pricing'],
  next_action: 'Human follows up about a demo',
  rolling_summary: 'Ahmed runs a digital marketing agency in Dubai.',
  captured_facts: {
    explicit_name: { value: 'Ahmed', evidence: 'My name is Ahmed' },
    business_industry: 'Digital Marketing Agency',
    location: 'Dubai',
    enquiry_volume_per_day: 40,
    sales_team_size: 5,
    languages: ['English', 'Malayalam'],
    needs: [
      'lead_qualification',
      'faq_answering',
      'human_handoff',
    ] as Array<'lead_qualification' | 'faq_answering' | 'human_handoff'>,
    pricing_requested: true,
    demo_requested: true,
  },
};

const v2Response = (
  text: string,
  requestId = externalGenerationRequestId(source.requestId, 1),
  traceId = 'trace-v2',
) => ({
  schema_version: '2' as const,
  request_id: requestId,
  trace_id: traceId,
  status: 'reply' as const,
  reply: { type: 'text' as const, text },
  checkpoint,
  handoff: null,
  actions: [],
  usage: { provider: 'sarvam', model: 'sarvam-105b-conversations' },
});

describe('external published-agent generation', () => {
  it('deriva UUIDs determinísticos e distintos por tentativa a partir do job CRM', () => {
    const first = externalGenerationRequestId(source.requestId, 1);
    const second = externalGenerationRequestId(source.requestId, 2);
    expect(first).toBe('581e14e0-31c3-5305-a450-999be12eb09a');
    expect(second).toBe('09098247-beb8-56c1-9373-428f8b14ae51');
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(first).toBe(externalGenerationRequestId(source.requestId, 1));
    expect(second).toBe(externalGenerationRequestId(source.requestId, 2));
    expect(first).not.toBe(second);
  });

  it('native é o default e só inbound publicado não-preview pode selecionar Python', () => {
    expect(shouldUseExternalRuntime({ runtime: undefined, jobKind: 'inbound_turn', hasPublishedAgent: true, preview: false })).toBe(false);
    expect(shouldUseExternalRuntime({ runtime: 'native', jobKind: 'inbound_turn', hasPublishedAgent: true, preview: false })).toBe(false);
    expect(shouldUseExternalRuntime({ runtime: 'python', jobKind: 'followup_turn', hasPublishedAgent: true, preview: false })).toBe(false);
    expect(shouldUseExternalRuntime({ runtime: 'python', jobKind: 'inbound_turn', hasPublishedAgent: false, preview: false })).toBe(false);
    expect(shouldUseExternalRuntime({ runtime: 'python', jobKind: 'inbound_turn', hasPublishedAgent: true, preview: true })).toBe(false);
    expect(shouldUseExternalRuntime({ runtime: 'python', jobKind: 'inbound_turn', hasPublishedAgent: true, preview: false })).toBe(true);
  });

  it.each([
    [
      'instructions',
      { instructions: 'x'.repeat(PYTHON_AGENT_MAX_INSTRUCTIONS_CHARS + 1) },
    ],
    [
      'input',
      { messageText: 'x'.repeat(PYTHON_AGENT_MAX_TEXT_CHARS + 1) },
    ],
    [
      'history',
      {
        history: [
          {
            direction: 'inbound' as const,
            body: 'x'.repeat(PYTHON_AGENT_MAX_TEXT_CHARS + 1),
            sent_at: '2026-09-25T01:00:00+00:00',
          },
        ],
      },
    ],
  ] as const)('faz handoff seguro quando %s excede o contrato Python', async (_field, patch) => {
    const call = vi.fn();
    const sendReply = vi.fn();
    const handoff = vi.fn(async () => undefined);

    const outcome = await executeExternalGeneration({
      source: { ...source, ...patch },
      config: { runtime: 'python', call },
      log,
      sendReply,
      handoff,
    });

    expect(outcome).toEqual({ kind: 'handoff', reason: 'request_too_large' });
    expect(handoff).toHaveBeenCalledExactlyOnceWith('external_request_too_large');
    expect(call).not.toHaveBeenCalled();
    expect(sendReply).not.toHaveBeenCalled();
  });

  it('mapeia IDs confiáveis, última mensagem e contexto mínimo sem telefone/credenciais', () => {
    const request = buildExternalAgentTurnRequest(source);
    expect(request).toMatchObject({
      request_id: externalGenerationRequestId(source.requestId, 1),
      organization_id: source.organizationId,
      channel_session_id: source.channelSessionId,
      conversation_id: source.conversationId,
      contact_id: source.contactId,
      agent: { id: source.agentId, version_id: source.agentVersionId },
      input: { text: source.messageText, reply_language: 'ar' },
      history: [
        { role: 'user', text: 'older' },
        { role: 'assistant', text: 'previous reply' },
        { role: 'user', text: 'latest unanswered' },
      ],
    });
    const serialized = JSON.stringify(request).toLowerCase();
    expect(serialized).not.toContain('phone');
    expect(serialized).not.toContain('credential');
    expect(serialized).not.toContain('supabase');
    expect(serialized).not.toContain('cookie');
    expect(serialized).not.toContain('jwt');
  });

  it('consulta normal no envelope Stage 1A passa uma única vez pelo executor compartilhado', async () => {
    const fetchMock = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { request_id: string };
      return new Response(
        JSON.stringify(response('Hello, how can I help?', body.request_id)),
        { status: 200 },
      );
    });
    const sendReply = vi.fn(async () => ({ ok: true as const, status: 'enviada' }));
    const handoff = vi.fn(async () => undefined);
    const outcome = await executeExternalGeneration({
      source: {
        ...source,
        messageText: 'Hello, I need help with your services.',
        replyLanguage: 'english',
      },
      config: {
        runtime: 'python',
        baseUrl: 'https://python.internal',
        secret: 'shared-secret',
        fetch: fetchMock as typeof fetch,
      },
      log,
      sendReply,
      handoff,
    });
    expect(outcome.kind).toBe('reply_processed');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(sendReply).toHaveBeenCalledExactlyOnceWith('Hello, how can I help?');
    expect(handoff).not.toHaveBeenCalled();
  });

  it('v2 entrega ao ledger a mesma resposta validada que contém o checkpoint', async () => {
    const accepted = v2Response('Hello Ahmed');
    const sendReply = vi.fn(async () => ({ ok: true as const, status: 'enviada' }));
    const outcome = await executeExternalGeneration({
      source,
      config: { runtime: 'python', call: vi.fn(async () => accepted) },
      log,
      sendReply,
      handoff: vi.fn(async () => undefined),
    });

    expect(sendReply).toHaveBeenCalledExactlyOnceWith('Hello Ahmed', accepted);
    expect(outcome).toEqual({
      kind: 'reply_processed',
      traceId: 'trace-v2',
      acceptedResponse: accepted,
    });
  });

  it('correção usa o UUID determinístico da tentativa 2; segunda falha vira handoff', async () => {
    const firstRequestId = externalGenerationRequestId(source.requestId, 1);
    const secondRequestId = externalGenerationRequestId(source.requestId, 2);
    const call = vi
      .fn()
      .mockResolvedValueOnce(response('Resposta errada', firstRequestId))
      .mockResolvedValueOnce(response('Ainda errada', secondRequestId, 'trace-2'));
    const sendReply = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'reply_language_mismatch', message: 'wrong language' },
    }));
    const handoff = vi.fn(async () => undefined);
    const outcome = await executeExternalGeneration({
      source,
      config: { runtime: 'python', call },
      log,
      sendReply,
      handoff,
    });
    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[0]?.[0]).toMatchObject({ request_id: firstRequestId, retry: { attempt: 1, reason: 'initial' } });
    expect(call.mock.calls[1]?.[0]).toMatchObject({ request_id: secondRequestId, retry: { attempt: 2, reason: 'language_mismatch' } });
    expect(handoff).toHaveBeenCalledExactlyOnceWith('external_reply_language_mismatch');
    expect(outcome.kind).toBe('handoff');
  });

  it('correção de idioma aceita a resposta da tentativa 2 sem handoff', async () => {
    const secondRequestId = externalGenerationRequestId(source.requestId, 2);
    const call = vi
      .fn()
      .mockResolvedValueOnce(response('Wrong language'))
      .mockResolvedValueOnce(response('الرد المصحح', secondRequestId, 'trace-2'));
    const sendReply = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false as const,
        error: { code: 'reply_language_mismatch', message: 'wrong language' },
      })
      .mockResolvedValueOnce({ ok: true as const, status: 'enviada' });
    const handoff = vi.fn(async () => undefined);

    const outcome = await executeExternalGeneration({
      source,
      config: { runtime: 'python', call },
      log,
      sendReply,
      handoff,
    });

    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1]?.[0]).toMatchObject({
      request_id: secondRequestId,
      retry: { attempt: 2, reason: 'language_mismatch' },
    });
    expect(sendReply).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({ kind: 'reply_processed', traceId: 'trace-2' });
    expect(handoff).not.toHaveBeenCalled();
  });

  it('não corta instruções para caber na correção; faz handoff antes da segunda chamada', async () => {
    const call = vi.fn(async () => response('Wrong language'));
    const sendReply = vi.fn(async () => ({
      ok: false as const,
      error: { code: 'reply_language_mismatch', message: 'wrong language' },
    }));
    const handoff = vi.fn(async () => undefined);

    const outcome = await executeExternalGeneration({
      source: {
        ...source,
        instructions: 'x'.repeat(PYTHON_AGENT_MAX_INSTRUCTIONS_CHARS - 50),
      },
      config: { runtime: 'python', call },
      log,
      sendReply,
      handoff,
    });

    expect(call).toHaveBeenCalledOnce();
    expect(sendReply).toHaveBeenCalledOnce();
    expect(handoff).toHaveBeenCalledExactlyOnceWith('external_request_too_large');
    expect(outcome).toEqual({ kind: 'handoff', reason: 'request_too_large' });
  });

  it('veto de vocabulário interno pede correção explícita e envia uma única resposta segura', async () => {
    const secondRequestId = externalGenerationRequestId(source.requestId, 2);
    const call = vi
      .fn()
      .mockResolvedValueOnce(response('I will update the papel in the CRM.'))
      .mockResolvedValueOnce(
        response('I will update your information for our team.', secondRequestId, 'trace-2'),
      );
    const delivered: string[] = [];
    const sendReply = vi.fn(async (text: string) => {
      if (text.includes('papel')) {
        return {
          ok: false as const,
          error: {
            code: 'internal_vocabulary_leak',
            message: 'rewrite without internal vocabulary',
          },
        };
      }
      delivered.push(text);
      return { ok: true as const, status: 'enviada' };
    });
    const handoff = vi.fn(async () => undefined);

    const outcome = await executeExternalGeneration({
      source,
      config: { runtime: 'python', call },
      log,
      sendReply,
      handoff,
    });

    expect(call).toHaveBeenCalledTimes(2);
    expect(call.mock.calls[1]?.[0]).toMatchObject({
      request_id: secondRequestId,
      retry: {
        attempt: 2,
        reason: 'internal_vocabulary_leak',
        rejected_draft: 'I will update the papel in the CRM.',
      },
    });
    expect(call.mock.calls[1]?.[0].agent.instructions).toContain(
      'Mandatory correction: rewrite the previous draft as customer-safe language.',
    );
    expect(sendReply).toHaveBeenCalledTimes(2);
    expect(delivered).toEqual(['I will update your information for our team.']);
    expect(outcome).toEqual({ kind: 'reply_processed', traceId: 'trace-2' });
    expect(handoff).not.toHaveBeenCalled();
  });

  it('v2 persiste como aceita somente a metadata da correção que passou', async () => {
    const secondRequestId = externalGenerationRequestId(source.requestId, 2);
    const rejected = v2Response('I will update the papel in the CRM.');
    const accepted = v2Response(
      'I will update your information for our team.',
      secondRequestId,
      'trace-v2-corrected',
    );
    const call = vi.fn().mockResolvedValueOnce(rejected).mockResolvedValueOnce(accepted);
    const sendReply = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false as const,
        error: { code: 'internal_vocabulary_leak', message: 'unsafe' },
      })
      .mockResolvedValueOnce({ ok: true as const, status: 'enviada' });

    const outcome = await executeExternalGeneration({
      source,
      config: { runtime: 'python', call },
      log,
      sendReply,
      handoff: vi.fn(async () => undefined),
    });

    expect(call.mock.calls[1]?.[0].retry.rejected_draft).toBe(rejected.reply.text);
    expect(sendReply.mock.calls[0]?.[1]).toBe(rejected);
    expect(sendReply.mock.calls[1]?.[1]).toBe(accepted);
    expect(outcome).toEqual({
      kind: 'reply_processed',
      traceId: 'trace-v2-corrected',
      acceptedResponse: accepted,
    });
  });

  it('segunda resposta com vocabulário interno continua vetada e termina em handoff', async () => {
    const secondRequestId = externalGenerationRequestId(source.requestId, 2);
    const call = vi
      .fn()
      .mockResolvedValueOnce(response('I will update the papel in the CRM.'))
      .mockResolvedValueOnce(
        response('The papel is updated in the CRM.', secondRequestId, 'trace-2'),
      );
    const sendReply = vi.fn(async () => ({
      ok: false as const,
      error: {
        code: 'internal_vocabulary_leak',
        message: 'rewrite without internal vocabulary',
      },
    }));
    const handoff = vi.fn(async () => undefined);

    const outcome = await executeExternalGeneration({
      source,
      config: { runtime: 'python', call },
      log,
      sendReply,
      handoff,
    });

    expect(call).toHaveBeenCalledTimes(2);
    expect(sendReply).toHaveBeenCalledTimes(2);
    expect(handoff).toHaveBeenCalledExactlyOnceWith('external_internal_vocabulary_leak');
    expect(outcome).toEqual({
      kind: 'handoff',
      traceId: 'trace-2',
      reason: 'internal_vocabulary_leak',
    });
  });

  it('409 na correção não ganha id alternativo: termina em handoff', async () => {
    const call = vi
      .fn()
      .mockResolvedValueOnce(response('Wrong language'))
      .mockRejectedValueOnce(new PythonAgentClientError('conflict', false, 'idempotency conflict', 409));
    const handoff = vi.fn(async () => undefined);
    const outcome = await executeExternalGeneration({
      source,
      config: { runtime: 'python', call },
      log,
      sendReply: vi.fn(async () => ({ ok: false as const, error: { code: 'reply_language_mismatch', message: 'wrong' } })),
      handoff,
    });
    expect(call.mock.calls[1]?.[0].request_id).toBe(
      externalGenerationRequestId(source.requestId, 2),
    );
    expect(handoff).toHaveBeenCalledExactlyOnceWith('external_conflict');
    expect(outcome.kind).toBe('handoff');
  });

  it('pedido humano explícito usa callback CRM; falha retryable sobe antes de qualquer envio', async () => {
    const handoff = vi.fn(async () => undefined);
    const handoffCall = vi.fn(async () => ({
      schema_version: '1' as const,
      request_id: externalGenerationRequestId(source.requestId, 1),
      trace_id: 'trace-handoff',
      status: 'handoff' as const,
      reply: null,
      handoff: { reason_code: 'explicit_human_request' },
      actions: [],
      usage: {
        provider: 'sarvam',
        model: 'sarvam-105b-conversations',
        input_tokens: null,
        output_tokens: null,
      },
    }));
    await executeExternalGeneration({
      source,
      config: { runtime: 'python', call: handoffCall },
      log,
      sendReply: vi.fn(),
      handoff,
    });
    expect(handoff).toHaveBeenCalledExactlyOnceWith('external_explicit_human_request');

    const sendReply = vi.fn();
    await expect(
      executeExternalGeneration({
        source,
        config: {
          runtime: 'python',
          call: vi.fn(async () => {
            throw new PythonAgentClientError('timeout', true, 'timeout');
          }),
        },
        log,
        sendReply,
        handoff,
      }),
    ).rejects.toMatchObject({ category: 'timeout', retryable: true });
    expect(sendReply).not.toHaveBeenCalled();
  });
});
