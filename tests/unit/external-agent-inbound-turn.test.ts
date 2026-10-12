import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const source = readFileSync('lib/agent-engine/agent/inbound-turn.ts', 'utf8');
const externalCall = source.indexOf('await executeExternalGeneration({');

describe('Stage 1B — posição do runtime externo no turno publicado', () => {
  it('todos os gates pré-geração permanecem antes da chamada Python', () => {
    expect(externalCall).toBeGreaterThan(0);
    for (const marker of [
      'await isLeadInHandoff(',
      'await decidirElegibilidadeDaConversa(',
      'agentConfig?.operationMode === "assisted"',
      'agentConfig.pausedAt',
      'await resolveConversationTurn(',
      'detectHumanHandoffRequest(texto)',
      'detectAmbiguousOptOut(texto)',
      'const mensagemMaisRecente =',
      'const replyLanguage = detectReplyLanguage(',
      'const tools = wrapToolsWithBreaker(',
    ]) {
      expect(source.indexOf(marker), marker).toBeGreaterThan(0);
      expect(source.indexOf(marker), marker).toBeLessThan(externalCall);
    }
  });

  it('Python só entra no inbound publicado não-preview e o nativo continua no seam existente', () => {
    const selector = source.indexOf('const usesExternalRuntime = shouldUseExternalRuntime({');
    const native = source.indexOf('const turn = await runModelCall(', externalCall);
    expect(selector).toBeGreaterThan(0);
    expect(selector).toBeLessThan(externalCall);
    expect(native).toBeGreaterThan(externalCall);
  });

  it('reply externo reutiliza a execute da send_message, sem segundo transporte', () => {
    const tool = source.indexOf('send_message: tool({');
    const sharedExecutor = source.indexOf('const sendMessageTool = rawTools.send_message', tool);
    const callback = source.indexOf('sendReply: async (text, acceptedResponse)', sharedExecutor);
    expect(tool).toBeGreaterThan(0);
    expect(sharedExecutor).toBeGreaterThan(tool);
    expect(callback).toBeGreaterThan(sharedExecutor);

    const externalSources = [
      readFileSync('lib/agent-engine/external/contracts.ts', 'utf8'),
      readFileSync('lib/agent-engine/external/generation.ts', 'utf8'),
      readFileSync('lib/agent-engine/external/python-agent-client.ts', 'utf8'),
    ].join('\n');
    expect(externalSources).not.toMatch(/Meta|WahaChannelAdapter|channel\.send|send_ledger/i);
  });

  it('UUID externo não substitui a identidade do job no executor de envio CRM', () => {
    const tool = source.indexOf('send_message: tool({');
    const ledgerJobId = source.indexOf('jobId: liveJob().id', tool);
    const externalRootId = source.indexOf('requestId: liveJob().id', externalCall);
    expect(ledgerJobId).toBeGreaterThan(tool);
    expect(ledgerJobId).toBeLessThan(externalCall);
    expect(externalRootId).toBeGreaterThan(externalCall);
  });

  it('nenhuma reserva de ledger ocorre antes de schema, echo e validação de idioma', () => {
    const client = readFileSync('lib/agent-engine/external/python-agent-client.ts', 'utf8');
    expect(client).toContain('externalAgentTurnResponseSchema.safeParse(json)');
    expect(client).toContain('parsedResponse.data.request_id !== request.request_id');
    expect(source.indexOf('executeExternalGeneration({')).toBeLessThan(
      source.indexOf('sendReply: async (text, acceptedResponse)'),
    );
    expect(source.indexOf('replyLanguage,', source.indexOf('const beforeSendArgs ='))).toBeGreaterThan(0);
  });
});
