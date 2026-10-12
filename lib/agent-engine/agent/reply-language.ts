export type ReplyLanguage =
  | "english"
  | "portuguese"
  | "malayalam"
  | "arabic"
  | "hindi"
  | "tamil"
  | "malayalam_english_mixed"
  | "undetermined";

export interface ReplyLanguageResult {
  language: ReplyLanguage;
  scripts: {
    latin: number;
    malayalam: number;
    arabic: number;
    devanagari: number;
    tamil: number;
  };
}

export interface ReplyLanguageValidation {
  valid: boolean;
  expected: ReplyLanguage;
  detected: ReplyLanguage;
}

const ENGLISH_MARKERS = new Set([
  "hello",
  "hi",
  "hey",
  "please",
  "thanks",
  "thank",
  "help",
  "today",
  "tomorrow",
  "good",
  "morning",
  "afternoon",
  "evening",
  "what",
  "when",
  "where",
  "why",
  "how",
  "can",
  "could",
  "would",
  "want",
  "need",
  "yes",
  "no",
  "my",
  "your",
  "you",
  "assist",
  "sure",
  "welcome",
]);

const PORTUGUESE_MARKERS = new Set([
  "oi",
  "ola",
  "olá",
  "bom",
  "boa",
  "dia",
  "tarde",
  "noite",
  "obrigado",
  "obrigada",
  "ajuda",
  "ajudar",
  "hoje",
  "amanha",
  "amanhã",
  "como",
  "quando",
  "onde",
  "porque",
  "quero",
  "preciso",
  "voce",
  "você",
  "seu",
  "sua",
  "sim",
  "nao",
  "não",
  "por",
  "favor",
  "claro",
  "posso",
  "auxiliar",
  "em",
  "que",
  "te",
  "bem-vindo",
  "bem-vinda",
]);

const PORTUGUESE_DIACRITICS = /[ãõçáéíóúâêôàü]/giu;
const URL = /https?:\/\/\S+|www\.\S+/giu;
const LATIN_WORD = /\p{Script=Latin}+/gu;
const INTERNAL_MEDIA_FRAME = /^\[Mídia do cliente:[^\]]+\]\s*/u;

/**
 * `corpoDaMensagem()` enquadra transcrição/visão com instruções internas em
 * português para o modelo não negar que ouviu/viu a mídia. Esse enquadramento
 * não é fala do cliente e, portanto, não pode votar no idioma da resposta.
 */
function customerLanguageSignal(text: string): string {
  const withoutFrame = text.replace(INTERNAL_MEDIA_FRAME, "");
  if (withoutFrame === text) return text;
  return withoutFrame
    .replace(/^Legenda do cliente:\s*/gmu, "")
    .replace(/^Conteúdo:\s*/gmu, "");
}

function countScript(
  text: string,
  script: "Latin" | "Malayalam" | "Arabic" | "Devanagari" | "Tamil",
): number {
  return [...text.matchAll(new RegExp(`\\p{Script=${script}}`, "gu"))].length;
}

function scriptsOf(text: string): ReplyLanguageResult["scripts"] {
  return {
    // URL/domain is not evidence that the customer chose a Latin language.
    latin: countScript(text.replace(URL, " "), "Latin"),
    malayalam: countScript(text, "Malayalam"),
    arabic: countScript(text, "Arabic"),
    devanagari: countScript(text, "Devanagari"),
    tamil: countScript(text, "Tamil"),
  };
}

function latinEvidence(text: string): { english: number; portuguese: number; meaningful: boolean } {
  const withoutUrls = text.replace(URL, " ");
  const words = (withoutUrls.match(LATIN_WORD) ?? []).map((word) => word.toLocaleLowerCase("und"));
  let english = 0;
  let portuguese = 0;
  for (const word of words) {
    if (ENGLISH_MARKERS.has(word)) english += 1;
    if (PORTUGUESE_MARKERS.has(word)) portuguese += 1;
  }
  portuguese += (withoutUrls.match(PORTUGUESE_DIACRITICS) ?? []).length;
  return {
    english,
    portuguese,
    meaningful: words.reduce((sum, word) => sum + word.length, 0) >= 2,
  };
}

function hasCompetingNativeScript(
  scripts: ReplyLanguageResult["scripts"],
  expected: ReplyLanguage,
): boolean {
  return (
    (expected !== "malayalam" && expected !== "malayalam_english_mixed" && scripts.malayalam > 0) ||
    (expected !== "arabic" && scripts.arabic > 0) ||
    (expected !== "hindi" && scripts.devanagari > 0) ||
    (expected !== "tamil" && scripts.tamil > 0)
  );
}

export function detectReplyLanguage(text: string): ReplyLanguageResult {
  const signal = customerLanguageSignal(text);
  const scripts = scriptsOf(signal);
  const latin = latinEvidence(signal);
  const meaningfulMalayalam = scripts.malayalam >= 2;
  const nativeScripts = [
    meaningfulMalayalam,
    scripts.arabic >= 2,
    scripts.devanagari >= 2,
    scripts.tamil >= 2,
  ].filter(Boolean).length;

  if (nativeScripts > 1) return { language: "undetermined", scripts };
  if (meaningfulMalayalam) {
    return {
      language: latin.meaningful ? "malayalam_english_mixed" : "malayalam",
      scripts,
    };
  }
  if (scripts.arabic >= 2) return { language: "arabic", scripts };
  if (scripts.devanagari >= 2) return { language: "hindi", scripts };
  if (scripts.tamil >= 2) return { language: "tamil", scripts };

  const normalized = signal.trim().toLocaleLowerCase("und");
  const explicitPortugueseGreeting = /^(?:oi|ol[aá])(?:\P{Letter}|$)/u.test(normalized);
  const explicitEnglishGreeting = /^(?:hello|hi|hey)(?:\P{Letter}|$)/u.test(normalized);
  if ((latin.portuguese >= 2 || explicitPortugueseGreeting) && latin.portuguese > latin.english) {
    return { language: "portuguese", scripts };
  }
  if ((latin.english >= 2 || explicitEnglishGreeting) && latin.english > latin.portuguese) {
    return { language: "english", scripts };
  }
  return { language: "undetermined", scripts };
}

export function renderReplyLanguageLock(result: ReplyLanguageResult): string {
  const common =
    "REPLY_LANGUAGE is a hard runtime constraint derived only from the customer's latest unanswered message. " +
    "Older conversation history, CRM locale, organization metadata, tool descriptions, and internal or platform Portuguese text must never override it.";

  if (result.language === "undetermined") {
    return `## REPLY_LANGUAGE\n${common}\nThe language is undetermined. Mirror the latest customer message naturally without inventing a language classification.`;
  }
  if (result.language === "malayalam_english_mixed") {
    return `## REPLY_LANGUAGE\n${common}\nExpected reply language: Malayalam-English mixed. The customer-facing reply must contain meaningful Malayalam. Ordinary English names, URLs, brand names, and technical terms are allowed.`;
  }
  return `## REPLY_LANGUAGE\n${common}\nExpected reply language: ${result.language}. Reply in ${result.language}.`;
}

export function validateReplyLanguage(
  candidate: string,
  expected: ReplyLanguageResult,
): ReplyLanguageValidation {
  const detected = detectReplyLanguage(candidate);
  const scripts = detected.scripts;
  const latin = latinEvidence(candidate);
  let valid: boolean;

  switch (expected.language) {
    case "malayalam":
      valid = scripts.malayalam >= 2 && !hasCompetingNativeScript(scripts, "malayalam");
      break;
    case "malayalam_english_mixed":
      valid =
        scripts.malayalam >= 2 &&
        !hasCompetingNativeScript(scripts, "malayalam_english_mixed") &&
        latin.portuguese <= latin.english;
      break;
    case "arabic":
      valid = scripts.arabic >= 2 && !hasCompetingNativeScript(scripts, "arabic");
      break;
    case "hindi":
      valid = scripts.devanagari >= 2 && !hasCompetingNativeScript(scripts, "hindi");
      break;
    case "tamil":
      valid = scripts.tamil >= 2 && !hasCompetingNativeScript(scripts, "tamil");
      break;
    case "english":
      valid = !hasCompetingNativeScript(scripts, "english") && detected.language !== "portuguese";
      break;
    case "portuguese":
      valid = !hasCompetingNativeScript(scripts, "portuguese") && detected.language !== "english";
      break;
    case "undetermined": {
      const expectedHasLatin = expected.scripts.latin > 0;
      valid = !expectedHasLatin || !hasCompetingNativeScript(scripts, "english");
      break;
    }
  }

  return { valid, expected: expected.language, detected: detected.language };
}

/**
 * Regra mais estrita para texto escrito pelo próprio produto. Um modelo pode
 * responder com nomes e termos estrangeiros; um aviso determinístico não tem
 * essa desculpa. Em escrita latina, qualquer evidência portuguesa vencendo a
 * inglesa (ou vice-versa) bloqueia antes do ledger/transporte.
 */
export function validateDeterministicReplyLanguage(
  candidate: string,
  expected: ReplyLanguageResult,
): ReplyLanguageValidation {
  const base = validateReplyLanguage(candidate, expected);
  if (!base.valid) return base;

  const latin = latinEvidence(candidate);
  const valid =
    expected.language === "english"
      ? latin.portuguese <= latin.english
      : expected.language === "portuguese"
        ? latin.english <= latin.portuguese
        : true;

  return { ...base, valid };
}
