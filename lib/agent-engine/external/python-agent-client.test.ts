import { createHmac } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { EXTERNAL_AGENT_SCHEMA_VERSION, type ExternalAgentTurnRequest } from './contracts';
import {
  callPythonAgent,
  PYTHON_AGENT_MAX_CONTEXT_CHARS,
  PYTHON_AGENT_MAX_INSTRUCTIONS_CHARS,
  PYTHON_AGENT_MAX_REQUEST_BYTES,
  PYTHON_AGENT_MAX_TEXT_CHARS,
  PythonAgentClientError,
  pythonAgentSignature,
  serializePythonAgentRequest,
} from './python-agent-client';

const IDS = {
  org: '11000000-0000-4000-8000-000000000001',
  channel: '11000000-0000-4000-8000-000000000002',
  conversation: '11000000-0000-4000-8000-000000000003',
  contact: '11000000-0000-4000-8000-000000000004',
  agent: '11000000-0000-4000-8000-000000000005',
  version: '11000000-0000-4000-8000-000000000006',
  message: '11000000-0000-4000-8000-000000000007',
};

const request: ExternalAgentTurnRequest = {
  schema_version: EXTERNAL_AGENT_SCHEMA_VERSION,
  request_id: '11000000-0000-4000-8000-000000000008',
  organization_id: IDS.org,
  channel_session_id: IDS.channel,
  conversation_id: IDS.conversation,
  contact_id: IDS.contact,
  agent: { id: IDS.agent, version_id: IDS.version, instructions: 'Be helpful.' },
  input: { message_id: IDS.message, type: 'text', text: 'Hello', reply_language: 'en' },
  history: [],
  context: {
    contact: { name: 'Customer', tags: [] },
    lead: { stage: 'new', next_action: null },
    previous_summary: null,
  },
  retry: { attempt: 1, reason: 'initial', rejected_draft: null },
};

function withRequest(
  patch: Partial<ExternalAgentTurnRequest>,
): ExternalAgentTurnRequest {
  return { ...request, ...patch } as ExternalAgentTurnRequest;
}

function requestAtSerializedBytes(targetBytes: number): ExternalAgentTurnRequest {
  const history: Extract<ExternalAgentTurnRequest, { schema_version: '2' }>['history'] = [];
  const candidate = withRequest({ history });
  for (;;) {
    history.push({
      role: 'user',
      text: '',
      sent_at: '2026-09-25T00:00:00.000Z',
    });
    const emptyBytes = Buffer.byteLength(JSON.stringify(candidate), 'utf8');
    const remaining = targetBytes - emptyBytes;
    if (remaining >= 0 && remaining <= PYTHON_AGENT_MAX_TEXT_CHARS) {
      history.at(-1)!.text = 'x'.repeat(remaining);
      return candidate;
    }
    history.at(-1)!.text = 'x'.repeat(PYTHON_AGENT_MAX_TEXT_CHARS);
    if (history.length >= 20) throw new Error('unable to construct request at byte boundary');
  }
}

const reply = JSON.stringify({
  schema_version: '1',
  request_id: request.request_id,
  trace_id: 'trace-1',
  status: 'reply',
  reply: { type: 'text', text: 'Hello! How can I help?' },
  handoff: null,
  actions: [],
  usage: { provider: 'sarvam', model: 'sarvam-105b-conversations', input_tokens: null, output_tokens: null },
});

const v2Reply = JSON.stringify({
  schema_version: '2',
  request_id: request.request_id,
  trace_id: 'trace-v2',
  status: 'reply',
  reply: { type: 'text', text: 'Hello Ahmed' },
  checkpoint: {
    commitments: [],
    objections: [],
    next_action: 'Follow up about demo',
    rolling_summary: 'Ahmed requested pricing and a demo.',
    captured_facts: {
      explicit_name: { value: 'Ahmed', evidence: 'My name is Ahmed' },
      business_industry: 'Digital Marketing Agency',
      location: 'Dubai',
      enquiry_volume_per_day: 40,
      sales_team_size: 5,
      languages: ['English', 'Malayalam'],
      needs: ['lead_qualification', 'faq_answering', 'human_handoff'],
      pricing_requested: true,
      demo_requested: true,
    },
  },
  handoff: null,
  actions: [],
  usage: { provider: 'sarvam', model: 'sarvam-105b-conversations' },
});

describe('python agent client', () => {
  it('assina exatamente timestamp.request_id.raw_body e envia o mesmo raw body', async () => {
    const fetchMock = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      const raw = String(init?.body);
      const headers = new Headers(init?.headers);
      const timestamp = headers.get('X-ZSAI-Timestamp');
      expect(timestamp).toBe('1790294400');
      const expected = createHmac('sha256', 'shared-secret')
        .update(`${timestamp}.${request.request_id}.${raw}`, 'utf8')
        .digest('hex');
      expect(headers.get('X-ZSAI-Signature')).toBe(expected);
      expect(headers.get('X-ZSAI-Request-Id')).toBe(request.request_id);
      expect(JSON.parse(raw)).toEqual(request);
      return new Response(reply, { status: 200 });
    });

    const result = await callPythonAgent(request, {
      baseUrl: 'https://python.internal/base/',
      secret: 'shared-secret',
      now: () => new Date('2026-09-25T00:00:00.000Z'),
      fetch: fetchMock as typeof fetch,
    });

    expect(result.status).toBe('reply');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://python.internal/base/internal/agent-turn',
    );
  });

  it('helper HMAC usa bytes UTF-8 sem normalizar o JSON', () => {
    const raw = '{"text":"മലയാളം"}';
    expect(pythonAgentSignature('secret', 'timestamp', 'request', raw)).toBe(
      createHmac('sha256', 'secret').update(`timestamp.request.${raw}`, 'utf8').digest('hex'),
    );
  });

  it('aceita 4.000 caracteres Malayalam medindo o teto de bytes separadamente', () => {
    const malayalam = 'മ'.repeat(PYTHON_AGENT_MAX_TEXT_CHARS);
    const raw = serializePythonAgentRequest(
      withRequest({ input: { ...request.input, text: malayalam } }),
    );

    expect(Array.from(malayalam)).toHaveLength(PYTHON_AGENT_MAX_TEXT_CHARS);
    expect(Buffer.byteLength(malayalam, 'utf8')).toBeGreaterThan(PYTHON_AGENT_MAX_TEXT_CHARS);
    expect(Buffer.byteLength(raw, 'utf8')).toBeLessThanOrEqual(PYTHON_AGENT_MAX_REQUEST_BYTES);
  });

  it.each([
    [
      'instructions',
      withRequest({
        agent: {
          ...request.agent,
          instructions: 'x'.repeat(PYTHON_AGENT_MAX_INSTRUCTIONS_CHARS + 1),
        },
      }),
    ],
    [
      'input',
      withRequest({
        input: { ...request.input, text: 'x'.repeat(PYTHON_AGENT_MAX_TEXT_CHARS + 1) },
      }),
    ],
    [
      'history',
      withRequest({
        history: [
          {
            role: 'user',
            text: 'x'.repeat(PYTHON_AGENT_MAX_TEXT_CHARS + 1),
            sent_at: '2026-09-25T00:00:00.000Z',
          },
        ],
      }),
    ],
    [
      'context',
      withRequest({
        context: {
          ...request.context,
          previous_summary: 'x'.repeat(PYTHON_AGENT_MAX_CONTEXT_CHARS),
        },
      }),
    ],
  ] as const)('rejeita %s acima do limite Python sem chamar transporte', async (_field, oversized) => {
    const fetchMock = vi.fn();
    const error = await callPythonAgent(oversized, {
      baseUrl: 'https://python.internal',
      secret: 'secret',
      fetch: fetchMock as typeof fetch,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      category: _field === 'context' ? 'configuration' : 'request_too_large',
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('aceita exatamente 64 KiB e rejeita o byte UTF-8 seguinte antes do fetch', async () => {
    const exact = requestAtSerializedBytes(PYTHON_AGENT_MAX_REQUEST_BYTES);
    const fetchMock = vi.fn(async () => new Response(reply, { status: 200 }));

    expect(Buffer.byteLength(serializePythonAgentRequest(exact), 'utf8')).toBe(
      PYTHON_AGENT_MAX_REQUEST_BYTES,
    );
    await expect(
      callPythonAgent(exact, {
        baseUrl: 'https://python.internal',
        secret: 'secret',
        fetch: fetchMock as typeof fetch,
      }),
    ).resolves.toMatchObject({ status: 'reply' });

    const oneByteOver = withRequest({
      ...exact,
      context: {
        ...exact.context,
        contact: { ...exact.context.contact, name: `${exact.context.contact.name}x` },
      },
    });
    expect(Buffer.byteLength(JSON.stringify(oneByteOver), 'utf8')).toBe(
      PYTHON_AGENT_MAX_REQUEST_BYTES + 1,
    );
    await expect(
      callPythonAgent(oneByteOver, {
        baseUrl: 'https://python.internal',
        secret: 'secret',
        fetch: fetchMock as typeof fetch,
      }),
    ).rejects.toMatchObject({ category: 'request_too_large', retryable: false });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('valida e devolve checkpoint v2 estruturado', async () => {
    const result = await callPythonAgent(request, {
      baseUrl: 'https://python.internal',
      secret: 'secret',
      fetch: vi.fn(async () => new Response(v2Reply, { status: 200 })) as typeof fetch,
    });

    expect(result).toMatchObject({
      schema_version: '2',
      status: 'reply',
      checkpoint: {
        captured_facts: {
          explicit_name: { value: 'Ahmed' },
          demo_requested: true,
        },
      },
    });
  });

  it('rejeita reply v2 sem checkpoint antes de qualquer envio CRM', async () => {
    const malformed = JSON.stringify({
      schema_version: '2',
      request_id: request.request_id,
      trace_id: 'trace-v2-bad',
      status: 'reply',
      reply: { type: 'text', text: 'Hello' },
      handoff: null,
      actions: [],
    });
    await expect(
      callPythonAgent(request, {
        baseUrl: 'https://python.internal',
        secret: 'secret',
        fetch: vi.fn(async () => new Response(malformed, { status: 200 })) as typeof fetch,
      }),
    ).rejects.toMatchObject({ category: 'invalid_response', retryable: false });
  });

  it.each([
    [429, 'rate_limited', true],
    [500, 'service_unavailable', true],
    [401, 'authentication', false],
    [422, 'contract_rejected', false],
    [409, 'conflict', false],
  ] as const)('classifica HTTP %s sem retry automático', async (status, category, retryable) => {
    const fetchMock = vi.fn(async () => new Response('{}', { status }));
    const error = await callPythonAgent(request, {
      baseUrl: 'https://python.internal',
      secret: 'secret',
      fetch: fetchMock as typeof fetch,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PythonAgentClientError);
    expect(error).toMatchObject({ category, retryable, status });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('classifica timeout e falha de rede como retryable sem repetir a chamada', async () => {
    const timeoutFetch = vi.fn(
      async (_url: URL | RequestInfo, init?: RequestInit): Promise<Response> =>
        await new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    await expect(
      callPythonAgent(request, {
        baseUrl: 'https://python.internal',
        secret: 'secret',
        timeoutMs: 1,
        fetch: timeoutFetch as typeof fetch,
      }),
    ).rejects.toMatchObject({ category: 'timeout', retryable: true });
    expect(timeoutFetch).toHaveBeenCalledOnce();

    const networkFetch = vi.fn(async () => {
      throw new Error('synthetic network failure');
    });
    await expect(
      callPythonAgent(request, {
        baseUrl: 'https://python.internal',
        secret: 'secret',
        fetch: networkFetch as typeof fetch,
      }),
    ).rejects.toMatchObject({ category: 'network', retryable: true });
    expect(networkFetch).toHaveBeenCalledOnce();
  });

  it('rejeita 2xx malformado e request_id ecoado divergente', async () => {
    const malformed = vi.fn(async () => new Response('{"status":"reply"}', { status: 200 }));
    await expect(
      callPythonAgent(request, {
        baseUrl: 'https://python.internal',
        secret: 'secret',
        fetch: malformed as typeof fetch,
      }),
    ).rejects.toMatchObject({ category: 'invalid_response', retryable: false });

    const wrongId = vi.fn(async () =>
      new Response(reply.replace(request.request_id, 'other-request'), { status: 200 }),
    );
    await expect(
      callPythonAgent(request, {
        baseUrl: 'https://python.internal',
        secret: 'secret',
        fetch: wrongId as typeof fetch,
      }),
    ).rejects.toMatchObject({ category: 'invalid_response', retryable: false });
  });

  it('aceita o envelope Stage 1A de handoff explícito', async () => {
    const handoff = JSON.stringify({
      schema_version: '1',
      request_id: request.request_id,
      trace_id: 'trace-handoff',
      status: 'handoff',
      reply: null,
      handoff: {
        reason_code: 'explicit_human_request',
        summary: 'Customer requested human handling',
      },
      actions: [],
      usage: {
        provider: 'sarvam',
        model: 'sarvam-105b-conversations',
        input_tokens: null,
        output_tokens: null,
      },
    });
    const result = await callPythonAgent(request, {
      baseUrl: 'https://python.internal',
      secret: 'secret',
      fetch: vi.fn(async () => new Response(handoff, { status: 200 })) as typeof fetch,
    });

    expect(result).toMatchObject({
      status: 'handoff',
      handoff: { reason_code: 'explicit_human_request' },
    });
  });

  it('corta resposta acima do teto antes de validar JSON', async () => {
    const fetchMock = vi.fn(async () => new Response('x'.repeat(101), { status: 200 }));
    await expect(
      callPythonAgent(request, {
        baseUrl: 'https://python.internal',
        secret: 'secret',
        maxResponseBytes: 100,
        fetch: fetchMock as typeof fetch,
      }),
    ).rejects.toMatchObject({ category: 'response_too_large', retryable: false });
  });
});
