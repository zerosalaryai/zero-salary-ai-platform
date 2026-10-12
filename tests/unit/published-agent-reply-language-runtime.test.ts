import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { inboundsNaoRespondidos } from "@/lib/agent-engine/agent/inbound-turn";
import { detectReplyLanguage } from "@/lib/agent-engine/agent/reply-language";
import { frameMediaBody } from "@/lib/agent-engine/edge/crm/get-lead-context";
import {
  disclosureGate,
  evaluateBeforeSend,
  replyLanguageGate,
  type GateContext,
} from "@/lib/agent-engine/guardrails/before-send";
import type { LeadContextMessage } from "@/lib/agent-engine/edge/crm/get-lead-context";

function gateContext(body: string, latestInbound: string, disclosure: string | null): GateContext {
  return {
    now: new Date("2026-09-24T10:00:00Z"),
    body,
    optedOut: false,
    provider: "meta_cloud",
    pacing: {
      knobs: {} as GateContext["pacing"]["knobs"],
      state: {} as GateContext["pacing"]["state"],
      crmDailyLimit: null,
    },
    spinning: { knobs: {} as GateContext["spinning"]["knobs"], window: [] },
    promise: { table: null },
    semanticPromise: null,
    disclosure: { template: disclosure, isFirstOutbound: disclosure !== null, mode: "inject" },
    lgpd: null,
    casesEnabled: false,
    hasOpenCase: false,
    openedCaseThisTurn: false,
    replyLanguage: detectReplyLanguage(latestInbound),
  };
}

describe("prioridade da última inbound sem resposta", () => {
  it.each([
    ["hello", "english"],
    ["നമസ്കാരം, എനിക്ക് സഹായം വേണം", "malayalam"],
  ] as const)("a mensagem mais recente %s vence histórico português", (latest, expected) => {
    const messages: LeadContextMessage[] = [
      { direction: "outbound", body: "Como posso ajudar?", sent_at: "2026-09-24T09:00:00Z" },
      { direction: "inbound", body: "Olá", sent_at: "2026-09-24T09:01:00Z" },
      { direction: "inbound", body: latest, sent_at: "2026-09-24T09:02:00Z" },
    ];
    const pending = inboundsNaoRespondidos(messages);
    expect(pending.at(-1)).toBe(latest);
    expect(detectReplyLanguage(pending.at(-1) ?? "").language).toBe(expected);
  });

  it("a última coalescida vence a mensagem mais antiga que criou o job", () => {
    const messages: LeadContextMessage[] = [
      { direction: "inbound", body: "Olá", sent_at: "2026-09-24T09:01:00Z" },
      { direction: "inbound", body: "hello, I need help", sent_at: "2026-09-24T09:01:03Z" },
    ];
    expect(detectReplyLanguage(inboundsNaoRespondidos(messages).at(-1) ?? "").language).toBe(
      "english",
    );
  });

  it("voz inglesa nova vence o histórico Malayalam/misto sem herdar o frame interno", () => {
    const transcript =
      "Hi, I run a digital marketing agency in Dubai. We receive many WhatsApp enquiries every day. Can your AI agent handle these enquiries, qualify leads and reply to customers automatically?";
    const messages: LeadContextMessage[] = [
      { direction: "inbound", body: "ഹായ്, എനിക്ക് സഹായം വേണം", sent_at: "2026-09-24T09:00:00Z" },
      { direction: "outbound", body: "തീർച്ചയായും, എങ്ങനെ സഹായിക്കാം?", sent_at: "2026-09-24T09:01:00Z" },
      { direction: "inbound", body: "Hi, എന്റെ visa status അറിയാമോ?", sent_at: "2026-09-24T09:02:00Z" },
      { direction: "outbound", body: "നിങ്ങളുടെ visa status പരിശോധിക്കാം.", sent_at: "2026-09-24T09:03:00Z" },
      { direction: "inbound", type: "audio", body: frameMediaBody("audio", null, transcript), sent_at: "2026-09-24T09:04:00Z" },
    ];

    const latest = inboundsNaoRespondidos(messages).at(-1) ?? "";
    const expected = detectReplyLanguage(latest);
    expect(expected.language).toBe("english");
    expect(evaluateBeforeSend(gateContext("Yes, it can qualify and reply to those leads.", latest, null), [replyLanguageGate]).veto).toBeNull();
  });
});

describe("transporte da trava ao provedor", () => {
  it("mantém a abertura como user e envia a trava ao runtime externo", () => {
    const source = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");
    const openingStart = source.indexOf("const openingTextOnly");
    const externalStart = source.indexOf("if (usesExternalRuntime)", openingStart);
    const externalEnd = source.indexOf("// O modelo decide tools", externalStart);
    const openingBlock = source.slice(openingStart, externalStart);
    const externalBlock = source.slice(externalStart, externalEnd);

    expect(openingBlock).toContain("{ role: 'user', content: openingText }");
    expect(openingBlock).not.toContain("role: 'system'");
    expect(externalBlock).toContain("instructions: `${system}\\n\\n${replyLanguageInstructions}`");
    expect(externalBlock).toContain("replyLanguage: replyLanguage.language");
  });
});

describe("barreira final de idioma", () => {
  it("aceita o fluxo inglês normal", () => {
    expect(evaluateBeforeSend(gateContext("Hello! How can I help you today?", "hello", null), [replyLanguageGate]).veto).toBeNull();
  });

  it("veta corpo português antes de qualquer callback de transporte", () => {
    const send = vi.fn();
    const result = evaluateBeforeSend(gateContext("Oi! Como posso ajudar você hoje?", "hello", null), [replyLanguageGate]);
    if (result.veto === null) send(result.body);
    expect(result.veto?.code).toBe("reply_language_mismatch");
    expect(send).not.toHaveBeenCalled();
  });

  it("valida o corpo depois que disclosure o transforma", () => {
    const result = evaluateBeforeSend(gateContext("Hello! How can I help?", "hello", "Olá! Sou a assistente virtual da empresa. Como posso ajudar você hoje?"), [disclosureGate, replyLanguageGate]);
    expect(result.body).toContain("assistente virtual");
    expect(result.veto?.code).toBe("reply_language_mismatch");
  });
});

describe("fiação do retry, template, ledger e aviso", () => {
  const inbound = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");
  const beforeSend = readFileSync("lib/agent-engine/guardrails/before-send.ts", "utf8");
  const external = readFileSync("lib/agent-engine/external/generation.ts", "utf8");
  const aviso = readFileSync("lib/agent-engine/agent/aviso-de-escalacao.ts", "utf8");

  it("runtime externo corrige uma vez e faz handoff após o segundo veto", () => {
    expect(external).toContain("first.error.code === 'reply_language_mismatch'");
    expect(external).toContain("attempt: 2");
    expect(external).toContain("await args.handoff(`external_${second.error.code}`)");
  });

  it("template incompatível permanece na cadeia before-send sem enviar", () => {
    const start = inbound.indexOf("send_template: tool({");
    const end = inbound.indexOf("search_knowledge: tool({", start);
    const block = inbound.slice(start, end);
    expect(block).toContain("isTemplate: true");
    expect(block).toContain("if (chain.status === 'vetoed')");
    expect(block.indexOf("seq += 1")).toBeGreaterThan(block.indexOf("const chain = await runBeforeSend"));
  });

  it("o gate veta antes de args.send, portanto antes de seq, ledger e canal", () => {
    const veto = beforeSend.indexOf("if (veto !== null)");
    const send = beforeSend.indexOf("const outcome = await args.send(ctx.body)");
    expect(veto).toBeGreaterThan(-1);
    expect(send).toBeGreaterThan(veto);
    const sendMessageStart = inbound.indexOf("send_message: tool({");
    const sendMessageBlock = inbound.slice(sendMessageStart, inbound.indexOf("update_lead_state: tool({", sendMessageStart));
    expect(sendMessageBlock.indexOf("seq += 1")).toBeGreaterThan(sendMessageBlock.indexOf("const beforeSendArgs ="));
  });

  it("aviso automático continua passando pela cadeia e pode ser suprimido", () => {
    expect(aviso).toContain("const chain = await runBeforeSend");
    expect(aviso).toContain("if (chain.status === 'vetoed')");
  });
});
