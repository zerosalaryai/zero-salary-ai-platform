import { describe, expect, it } from "vitest";

import {
  detectReplyLanguage,
  renderReplyLanguageLock,
  validateReplyLanguage,
} from "@/lib/agent-engine/agent/reply-language";

describe("detecção determinística do idioma de resposta", () => {
  it.each([
    ["hello, how can you help me today?", "english"],
    ["Olá, como posso ajudar você hoje?", "portuguese"],
    ["നമസ്കാരം, എനിക്ക് സഹായം വേണം", "malayalam"],
    ["مرحبا، أحتاج إلى مساعدة", "arabic"],
    ["नमस्ते, मुझे सहायता चाहिए", "hindi"],
    ["வணக்கம், எனக்கு உதவி வேண்டும்", "tamil"],
    ["Hi, എന്റെ visa status അറിയാമോ?", "malayalam_english_mixed"],
    ["👋🙂", "undetermined"],
    ["https://example.com/path", "undetermined"],
    ["Acme", "undetermined"],
  ] as const)("%s → %s", (text, expected) => {
    expect(detectReplyLanguage(text).language).toBe(expected);
  });

  it("não inventa classificação no lock indeterminado", () => {
    const lock = renderReplyLanguageLock(detectReplyLanguage("Acme"));
    expect(lock).toContain("The language is undetermined");
    expect(lock).toContain("latest unanswered message");
    expect(lock).toContain("CRM locale");
  });

  it("torna Malayalam obrigatório no lock misto", () => {
    const lock = renderReplyLanguageLock(detectReplyLanguage("Hi, എനിക്ക് help വേണം"));
    expect(lock).toContain("Malayalam-English mixed");
    expect(lock).toContain("must contain meaningful Malayalam");
  });
});

describe("validação do corpo final", () => {
  const validate = (candidate: string, inbound: string) =>
    validateReplyLanguage(candidate, detectReplyLanguage(inbound)).valid;

  it("aceita inglês e rejeita português para inbound inglês", () => {
    expect(validate("Hi! How can I help you today?", "hello")).toBe(true);
    expect(validate("Oi! Como posso ajudar você hoje?", "hello")).toBe(false);
    expect(validate("Claro! Em que posso te auxiliar?", "hello")).toBe(false);
  });

  it("aceita Malayalam e rejeita resposta apenas em inglês", () => {
    expect(validate("നമസ്കാരം! എങ്ങനെ സഹായിക്കാം?", "നമസ്കാരം")).toBe(true);
    expect(validate("Hello! How can I help?", "നമസ്കാരം")).toBe(false);
  });

  it("aceita Malayalam-English misto e rejeita português", () => {
    const inbound = "Hi, എന്റെ visa status അറിയാമോ?";
    expect(validate("തീർച്ചയായും, നിങ്ങളുടെ visa status പരിശോധിക്കാം.", inbound)).toBe(true);
    expect(validate("Oi! Como posso ajudar você hoje?", inbound)).toBe(false);
  });

  it("rejeita scripts contraditórios", () => {
    expect(validate("مرحبا، كيف أساعدك؟", "നമസ്കാരം")).toBe(false);
    expect(validate("வணக்கம், எப்படி உதவலாம்?", "مرحبا")).toBe(false);
  });

  it("é permissivo para entrada sem idioma determinável", () => {
    expect(validate("Hello, Acme!", "Acme")).toBe(true);
    expect(validate("Olá, Acme!", "👋")).toBe(true);
  });
});
