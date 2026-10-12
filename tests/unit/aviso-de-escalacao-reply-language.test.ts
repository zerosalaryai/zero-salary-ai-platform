import { afterEach, describe, expect, it, vi } from "vitest";

import { detectReplyLanguage } from "@/lib/agent-engine/agent/reply-language";

const ids = {
  tenantId: "11111111-1111-4111-8111-111111111111",
  leadId: "22222222-2222-4222-8222-222222222222",
  conversationId: "33333333-3333-4333-8333-333333333333",
  channelSessionId: "44444444-4444-4444-8444-444444444444",
  jobId: "job-1",
};

afterEach(() => {
  vi.resetModules();
  vi.doUnmock("@/lib/agent-engine/guardrails/before-send");
  vi.doUnmock("@/lib/escalacao/disponibilidade");
  vi.doUnmock("@/lib/escalacao/aviso-ao-lead");
});

async function loadNoticeSender(options: { body?: string } = {}) {
  const runBeforeSend = vi.fn(async (_input: unknown) => ({
    status: "ok" as const,
    outcome: { kind: "sent" as const, idempotencyKey: "k", messageId: "m" },
  }));
  vi.doMock("@/lib/agent-engine/guardrails/before-send", () => ({ runBeforeSend }));
  vi.doMock("@/lib/escalacao/disponibilidade", () => ({
    expectativaDeAtendimento: vi.fn(async () => ({ quem: null, frase: "" })),
  }));
  if (options.body !== undefined) {
    vi.doMock("@/lib/escalacao/aviso-ao-lead", () => ({
      textoDoAviso: vi.fn(() => options.body),
    }));
  }
  const noticeModule = await import("@/lib/agent-engine/agent/aviso-de-escalacao");
  return { avisarLeadDaEscalacao: noticeModule.avisarLeadDaEscalacao, runBeforeSend };
}

function options(language: ReturnType<typeof detectReplyLanguage>, send = vi.fn()) {
  return {
    motivo: "pediu_humano" as const,
    channel: { send } as never,
    optedOutThisTurn: false,
    now: new Date("2026-09-24T10:00:00Z"),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    replyLanguage: language,
  };
}

describe("aviso de escalação respeita a trava de idioma", () => {
  it("gera e envia o aviso no idioma do turno", async () => {
    const { avisarLeadDaEscalacao, runBeforeSend } = await loadNoticeSender();
    const language = detectReplyLanguage("hello, I need a person");

    const result = await avisarLeadDaEscalacao({} as never, ids, options(language));

    expect(result).toEqual({ avisado: true });
    expect(runBeforeSend).toHaveBeenCalledOnce();
    expect(runBeforeSend.mock.calls[0]?.[0]).toMatchObject({
      replyLanguage: language,
      body: expect.stringMatching(/[A-Za-z]/),
    });
  });

  it("veta aviso em idioma divergente antes da cadeia de envio", async () => {
    const { avisarLeadDaEscalacao, runBeforeSend } = await loadNoticeSender({
      body: "Olá, uma pessoa da equipe falará com você.",
    });
    const send = vi.fn();

    const result = await avisarLeadDaEscalacao(
      {} as never,
      ids,
      options(detectReplyLanguage("hello, I need a person"), send),
    );

    expect(result).toEqual({ avisado: false, porque: "reply_language_mismatch" });
    expect(runBeforeSend).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});
