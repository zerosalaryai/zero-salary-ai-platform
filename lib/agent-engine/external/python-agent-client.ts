import { createHmac } from 'node:crypto';

import {
  externalAgentTurnRequestSchema,
  externalAgentTurnResponseSchema,
  type ExternalAgentTurnRequest,
  type ExternalAgentTurnResponse,
} from './contracts';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
export const PYTHON_AGENT_MAX_REQUEST_BYTES = 64 * 1024;
export const PYTHON_AGENT_MAX_INSTRUCTIONS_CHARS = 12_000;
export const PYTHON_AGENT_MAX_TEXT_CHARS = 4_000;
export const PYTHON_AGENT_MAX_CONTEXT_CHARS = 12_000;

export type PythonAgentErrorCategory =
  | 'configuration'
  | 'request_too_large'
  | 'timeout'
  | 'network'
  | 'rate_limited'
  | 'service_unavailable'
  | 'authentication'
  | 'contract_rejected'
  | 'conflict'
  | 'invalid_response'
  | 'response_too_large';

export class PythonAgentClientError extends Error {
  constructor(
    readonly category: PythonAgentErrorCategory,
    readonly retryable: boolean,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'PythonAgentClientError';
  }
}

export interface PythonAgentClientConfig {
  baseUrl?: string;
  secret?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

export function pythonAgentSignature(
  secret: string,
  timestamp: string,
  requestId: string,
  rawBody: string,
): string {
  return createHmac('sha256', secret)
    .update(`${timestamp}.${requestId}.${rawBody}`, 'utf8')
    .digest('hex');
}

function unicodeLength(value: string): number {
  return Array.from(value).length;
}

function assertCharacterLimit(value: string, max: number): void {
  if (unicodeLength(value) > max) {
    throw new PythonAgentClientError(
      'request_too_large',
      false,
      'pedido externo excede o contrato do runtime',
    );
  }
}

/**
 * Mirrors the Python entry-point limits without changing or truncating customer context.
 * The returned bytes are the exact body that must be signed and transmitted.
 */
export function serializePythonAgentRequest(request: ExternalAgentTurnRequest): string {
  assertCharacterLimit(request.agent.instructions, PYTHON_AGENT_MAX_INSTRUCTIONS_CHARS);
  assertCharacterLimit(request.input.text, PYTHON_AGENT_MAX_TEXT_CHARS);
  for (const message of request.history) {
    assertCharacterLimit(message.text, PYTHON_AGENT_MAX_TEXT_CHARS);
  }
  assertCharacterLimit(JSON.stringify(request.context), PYTHON_AGENT_MAX_CONTEXT_CHARS);

  const rawBody = JSON.stringify(request);
  if (Buffer.byteLength(rawBody, 'utf8') > PYTHON_AGENT_MAX_REQUEST_BYTES) {
    throw new PythonAgentClientError(
      'request_too_large',
      false,
      'pedido externo excede o teto de bytes do runtime',
    );
  }
  return rawBody;
}

function endpointOf(raw: string | undefined): URL {
  if (raw === undefined || raw.trim() === '') {
    throw new PythonAgentClientError('configuration', false, 'ZSAI_PYTHON_AGENT_URL ausente');
  }
  let base: URL;
  try {
    base = new URL(raw);
  } catch {
    throw new PythonAgentClientError('configuration', false, 'ZSAI_PYTHON_AGENT_URL inválida');
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new PythonAgentClientError('configuration', false, 'protocolo do runtime externo inválido');
  }
  base.pathname = `${base.pathname.replace(/\/$/, '')}/internal/agent-turn`;
  base.search = '';
  base.hash = '';
  return base;
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new PythonAgentClientError('response_too_large', false, 'resposta externa excede o teto');
  }
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new PythonAgentClientError('response_too_large', false, 'resposta externa excede o teto');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function httpError(status: number): PythonAgentClientError {
  if (status === 429) return new PythonAgentClientError('rate_limited', true, 'runtime externo limitou a chamada', status);
  if (status >= 500) return new PythonAgentClientError('service_unavailable', true, 'runtime externo indisponível', status);
  if (status === 401 || status === 403) return new PythonAgentClientError('authentication', false, 'runtime externo recusou autenticação', status);
  if (status === 409) return new PythonAgentClientError('conflict', false, 'runtime externo recusou a variação idempotente', status);
  return new PythonAgentClientError('contract_rejected', false, 'runtime externo recusou o contrato', status);
}

export async function callPythonAgent(
  request: ExternalAgentTurnRequest,
  config: PythonAgentClientConfig,
): Promise<ExternalAgentTurnResponse> {
  const parsedRequest = externalAgentTurnRequestSchema.safeParse(request);
  if (!parsedRequest.success) {
    throw new PythonAgentClientError('configuration', false, 'pedido externo inválido antes do envio');
  }
  const secret = config.secret?.trim();
  if (!secret) {
    throw new PythonAgentClientError('configuration', false, 'ZSAI_INTERNAL_AGENT_SECRET ausente');
  }

  const rawBody = serializePythonAgentRequest(parsedRequest.data);
  const timestamp = Math.floor((config.now ?? (() => new Date()))().getTime() / 1_000).toString();
  const signature = pythonAgentSignature(secret, timestamp, request.request_id, rawBody);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let response: Response;
  try {
    response = await (config.fetch ?? fetch)(endpointOf(config.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-ZSAI-Request-Id': request.request_id,
        'X-ZSAI-Timestamp': timestamp,
        'X-ZSAI-Signature': signature,
      },
      body: rawBody,
      signal: controller.signal,
    });
  } catch {
    if (controller.signal.aborted) {
      throw new PythonAgentClientError('timeout', true, 'runtime externo excedeu o timeout');
    }
    throw new PythonAgentClientError('network', true, 'falha de rede no runtime externo');
  } finally {
    clearTimeout(timeout);
  }

  const responseBody = await readBoundedBody(
    response,
    config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
  );
  if (!response.ok) throw httpError(response.status);

  let json: unknown;
  try {
    json = JSON.parse(responseBody);
  } catch {
    throw new PythonAgentClientError('invalid_response', false, 'runtime externo devolveu JSON inválido');
  }
  const parsedResponse = externalAgentTurnResponseSchema.safeParse(json);
  if (!parsedResponse.success) {
    throw new PythonAgentClientError('invalid_response', false, 'runtime externo devolveu contrato inválido');
  }
  if (parsedResponse.data.request_id !== request.request_id) {
    throw new PythonAgentClientError('invalid_response', false, 'runtime externo ecoou request_id divergente');
  }
  return parsedResponse.data;
}
