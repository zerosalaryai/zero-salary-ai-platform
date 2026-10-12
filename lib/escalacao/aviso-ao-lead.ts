/**
 * A FRASE QUE O CLIENTE LÊ QUANDO A IA SAI DE CAMPO.
 *
 * ## O defeito que este arquivo existe para consertar
 *
 * O sistema tem duas passagens para humano, escritas por times diferentes e em
 * mundos diferentes — `performHumanHandoff` (motor, `pg`) e `triggerHandoff`
 * (CRM, `supabase-js`). As duas fazem a mesma coisa bem: silenciam o automático,
 * devolvem a conversa à fila e abrem o aviso na Central. E as duas fazem a mesma
 * coisa errada: **não dizem nada a quem está do outro lado**.
 *
 * Medido em produção em 2026-08-26, duas conversas reais na mesma hora:
 *
 *   - conversa `b934ba2d` — o cliente disse que não conseguia acessar um curso; o
 *     agente respondeu e PERGUNTOU o e-mail dele. Entre a pergunta e a resposta,
 *     o worker de sentimento disparou `triggerHandoff('low_sentiment')`. O cliente
 *     mandou o e-mail às 14:51:2x e o turno foi pulado ("lead em handoff humano").
 *     Ele respondeu uma pergunta da própria IA para o vazio.
 *   - conversa `cdd9cbd8` — o cliente escreveu "preciso de falar com atendente".
 *     A detecção determinística casou, `performHumanHandoff` rodou e o turno deu
 *     `return` com o comentário "bot silencia: sem modelo, sem envio neste turno".
 *     Silêncio absoluto.
 *
 * Do lado de fora as duas são a mesma coisa: a pessoa falou e ninguém respondeu.
 * O invariante 4 da doutrina do Sistema Vivo — nenhuma demanda sem próximo passo —
 * vale para o SISTEMA e valia; o que faltava era ele valer para a PESSOA.
 *
 * ## Por que o texto mora aqui, e sozinho
 *
 * Porque são dois emissores e um texto. Deixar cada mundo escrever a própria
 * frase é como as sete leituras de "quem manda na conversa" divergiram
 * (`lib/inbox/comando-da-conversa.ts`): dois lugares, duas redações, e a segunda
 * envelhece calada. Aqui a função é PURA — comparar frase é barato, comparar
 * linha de banco é caro — e cada mundo só a chama.
 *
 * ## Por que o texto muda com o MOTIVO
 *
 * "Vou chamar um atendente" está certo para quem pediu atendente e está ERRADO
 * para quem pediu para parar de receber mensagem. O motivo já viaja até aqui
 * (`conversations.last_handoff_reason`), então a frase o respeita em vez de
 * escolher um genérico que serve mal aos dois.
 *
 * ## Por que o texto muda com a DISPONIBILIDADE
 *
 * Mesma razão de `fraseDeExpectativa` em `./disponibilidade.ts`, e a mesma
 * fonte: prometer "alguém já vai te atender" para uma conta que não tem NINGUÉM
 * configurado é a pior primeira impressão possível num produto self-host, e é o
 * estado real de toda instalação recém-feita. A diferença é o destinatário —
 * lá a frase é INSTRUÇÃO ao modelo, aqui é FALA ao cliente.
 */

import { createHash } from "node:crypto";

import type { ReplyLanguage } from "@/lib/agent-engine/agent/reply-language";
import type { QuemPodeAssumir } from "./disponibilidade";

/**
 * Por que a IA está saindo de campo. É o mesmo vocabulário de
 * `conversations.last_handoff_reason` — `HandoffReason` do orquestrador do CRM e
 * o `reason` que o motor grava —, reduzido ao que MUDA A FRASE.
 *
 * `outro` não é preguiça: os motivos são vocabulário aberto (o atendente escreve
 * texto livre ao escalar um caso), e um mapa exaustivo obrigaria este arquivo a
 * conhecer cada motivo novo para não quebrar. O default é a frase honesta e
 * genérica — nunca o silêncio.
 */
export type MotivoDoAviso =
  /** O cliente pediu uma pessoa, com todas as letras. */
  | "pediu_humano"
  /** Suspeita de que o cliente pediu para parar de receber mensagens. */
  | "suspeita_de_opt_out"
  /** O teto de gasto com IA parou o atendimento automático. */
  | "orcamento_de_ia"
  /** O sistema decidiu escalar (sentimento, baixa confiança, etapa, termo jurídico…). */
  | "outro";

/**
 * Traduz o `last_handoff_reason` gravado no banco para o motivo que muda a frase.
 * Aceita `string` porque a coluna é vocabulário ABERTO — ver `MotivoDoAviso`.
 */
export function motivoDoAviso(reason: string): MotivoDoAviso {
  if (reason === "requested_human") return "pediu_humano";
  if (reason === "suspected_optout") return "suspeita_de_opt_out";
  if (reason === "orcamento_de_ia") return "orcamento_de_ia";
  return "outro";
}

/**
 * ═══ POR QUE HÁ VARIANTES, E POR QUE ELAS SÃO SORTEADAS PELO LEAD ═══
 *
 * Porque um texto FIXO se veta sozinho. O `spinningGate` da cadeia de envio
 * (`lib/agent-engine/spinning/engine.ts`) conta quantas das últimas 20 mensagens
 * DAQUELE NÚMERO são idênticas ou quase (Jaccard ≥ 0,8) à candidata, e veta a
 * partir da terceira (`SPINNING_DEFAULTS.repetitionThreshold = 2`). A janela é
 * por `(organization_id, channel_session_id)` — ou seja, CRUZA leads. Numa
 * central com movimento, o terceiro cliente a pedir um atendente receberia
 * exatamente o silêncio que este arquivo existe para acabar, e pelo guardrail
 * que existe para proteger o número.
 *
 * A saída é a mesma que a re-entrada determinística já usa
 * (`pickReentryVariant`): variante escolhida por hash do lead. Mesmo lead ⇒
 * sempre a mesma frase (nada de o cliente ver a redação mudar entre tentativas
 * do mesmo job); leads diferentes ⇒ frases diferentes. Sem estado, sem relógio.
 *
 * As variantes NÃO são a mesma frase com sinônimos: um "spin" superficial não
 * baixa o Jaccard, e o gate o pega igual. `tests/unit/aviso-ao-lead.test.ts`
 * mede a similaridade entre TODOS os pares com a função REAL do gate — é ela
 * que diz se as variantes são de verdade, não a nossa impressão ao lê-las.
 */

/** Aberturas por motivo. O índice sai do hash do lead — ver o bloco acima. */
const ABERTURAS_EM_PORTUGUES: Record<MotivoDoAviso, readonly string[]> = {
  // Quem pediu para parar não quer ouvir sobre atendente. Confirma o que ele
  // pediu, diz que uma pessoa vai conferir, e para. Responder ao pedido de
  // parada é padrão de mensageria (a confirmação de opt-out), não insistência.
  suspeita_de_opt_out: [
    "Entendi. Vou parar de te enviar mensagens automáticas por aqui.",
    "Certo, anotado: não mando mais nada automático para este número.",
    "Ok! Encerro os envios automáticos deste canal agora mesmo.",
  ],
  pediu_humano: [
    "Claro! Já estou chamando alguém da equipe para falar com você.",
    "Sem problema — acabei de acionar uma pessoa do time para continuar daqui.",
    "Perfeito. Passei sua conversa para um atendente humano agora.",
  ],
  orcamento_de_ia: [
    "Vou passar seu atendimento para uma pessoa da equipe.",
    "A partir daqui quem continua com você é alguém do time.",
    "Estou transferindo esta conversa para um atendente humano.",
  ],
  outro: [
    "Esse caso é melhor resolvido por uma pessoa. Já acionei o time.",
    "Prefiro não arriscar aqui: passei seu pedido para um atendente humano.",
    "Vou pedir ajuda de alguém da equipe para cuidar disso com você.",
  ],
};

/** Fechos por estado da equipe. Mesmo sorteio, mesma razão. */
const FECHOS_EM_PORTUGUES = {
  /** Ninguém configurado, ou leitura falhou: NADA de prazo. */
  sem_equipe: [
    "Seu pedido ficou registrado e a equipe responde assim que possível.",
    "Deixei tudo anotado; retornamos para você assim que der.",
    "Já registrei aqui, e alguém te responde na primeira oportunidade.",
  ],
  /** Tem equipe, ninguém elegível agora: nada de prazo curto. */
  fora_de_expediente: [
    "No momento ninguém está disponível, mas seu pedido ficou registrado.",
    "Agora não tem ninguém livre; deixei sua solicitação anotada para o time.",
    "Não há atendente disponível neste instante — sua conversa entrou na fila.",
  ],
  /** Há gente elegível: pode convidar a aguardar. */
  com_equipe: [
    "É só aguardar um instante aqui na conversa.",
    "Fica por aqui que já te respondem.",
    "Aguarde só um momento nesta conversa, por favor.",
  ],
} as const;

interface TextosDoAviso {
  aberturas: Record<MotivoDoAviso, readonly string[]>;
  fechos: {
    sem_equipe: readonly string[];
    fora_de_expediente: readonly string[];
    com_equipe: readonly string[];
  };
  confirmacaoOptOut: string;
}

const TEXTOS_POR_IDIOMA: Record<Exclude<ReplyLanguage, "undetermined">, TextosDoAviso> = {
  portuguese: {
    aberturas: ABERTURAS_EM_PORTUGUES,
    fechos: FECHOS_EM_PORTUGUES,
    confirmacaoOptOut: "Encaminhei seu pedido para uma pessoa da equipe confirmar.",
  },
  english: {
    aberturas: {
      suspeita_de_opt_out: ["Understood. I’ll stop sending automated messages here."],
      pediu_humano: ["Of course. I’m bringing in a member of our team to speak with you."],
      orcamento_de_ia: ["I’m transferring your conversation to a member of our team."],
      outro: ["A member of our team is better placed to help with this. I’ve notified them."],
    },
    fechos: {
      sem_equipe: ["Your request has been recorded, and the team will reply as soon as possible."],
      fora_de_expediente: ["No one is available right now, but your request is in the team’s queue."],
      com_equipe: ["Please stay in this conversation; someone will reply shortly."],
    },
    confirmacaoOptOut: "I’ve sent your request to a team member for confirmation.",
  },
  malayalam: {
    aberturas: {
      suspeita_de_opt_out: ["മനസ്സിലായി. ഇനി ഇവിടെ സ്വയമേവയുള്ള സന്ദേശങ്ങൾ അയയ്ക്കില്ല."],
      pediu_humano: ["തീർച്ചയായും. നിങ്ങളുമായി സംസാരിക്കാൻ ടീമിലെ ഒരാളെ അറിയിച്ചിട്ടുണ്ട്."],
      orcamento_de_ia: ["നിങ്ങളുടെ സംഭാഷണം ടീമിലെ ഒരാൾക്ക് കൈമാറുന്നു."],
      outro: ["ഇത് ടീമിലെ ഒരാൾ കൈകാര്യം ചെയ്യുന്നതാണ് ഉചിതം. അവരെ അറിയിച്ചിട്ടുണ്ട്."],
    },
    fechos: {
      sem_equipe: ["നിങ്ങളുടെ അഭ്യർഥന രേഖപ്പെടുത്തി; കഴിയുന്നത്ര വേഗം ടീം മറുപടി നൽകും."],
      fora_de_expediente: ["ഇപ്പോൾ ആരും ലഭ്യമല്ല; നിങ്ങളുടെ അഭ്യർഥന ടീമിന്റെ നിരയിൽ ചേർത്തിട്ടുണ്ട്."],
      com_equipe: ["ഈ സംഭാഷണത്തിൽ ഒരു നിമിഷം കാത്തിരിക്കൂ; ഒരാൾ ഉടൻ മറുപടി നൽകും."],
    },
    confirmacaoOptOut: "ഇത് സ്ഥിരീകരിക്കാൻ നിങ്ങളുടെ അഭ്യർഥന ടീമിലെ ഒരാൾക്ക് കൈമാറി.",
  },
  malayalam_english_mixed: {
    aberturas: {
      suspeita_de_opt_out: ["Okay — ഇനി ഇവിടെ automated messages അയയ്ക്കില്ല."],
      pediu_humano: ["Sure — നിങ്ങളോട് സംസാരിക്കാൻ team member-നെ അറിയിച്ചിട്ടുണ്ട്."],
      orcamento_de_ia: ["നിങ്ങളുടെ conversation ഒരു team member-ന് കൈമാറുന്നു."],
      outro: ["ഇത് ഒരു team member handle ചെയ്യുന്നതാണ് നല്ലത്; അവരെ അറിയിച്ചിട്ടുണ്ട്."],
    },
    fechos: {
      sem_equipe: ["നിങ്ങളുടെ request രേഖപ്പെടുത്തി; team കഴിയുന്നത്ര വേഗം reply ചെയ്യും."],
      fora_de_expediente: ["ഇപ്പോൾ ആരും available അല്ല; request team queue-യിൽ ചേർത്തിട്ടുണ്ട്."],
      com_equipe: ["ഈ chat-ൽ ഒരു moment കാത്തിരിക്കൂ; ഒരാൾ ഉടൻ reply ചെയ്യും."],
    },
    confirmacaoOptOut: "Confirmation-നായി request ഒരു team member-ന് കൈമാറി.",
  },
  arabic: {
    aberturas: {
      suspeita_de_opt_out: ["فهمت. سأتوقف عن إرسال الرسائل التلقائية هنا."],
      pediu_humano: ["بالتأكيد. أبلغت أحد أعضاء الفريق ليتحدث معك."],
      orcamento_de_ia: ["سأحوّل محادثتك إلى أحد أعضاء الفريق."],
      outro: ["من الأفضل أن يساعدك أحد أعضاء الفريق في هذا الأمر. لقد أبلغتهم."],
    },
    fechos: {
      sem_equipe: ["تم تسجيل طلبك، وسيرد الفريق في أقرب وقت ممكن."],
      fora_de_expediente: ["لا أحد متاح الآن، لكن طلبك أُضيف إلى قائمة انتظار الفريق."],
      com_equipe: ["يرجى البقاء في هذه المحادثة؛ سيرد عليك أحدهم قريبًا."],
    },
    confirmacaoOptOut: "أرسلت طلبك إلى أحد أعضاء الفريق للتأكيد.",
  },
  hindi: {
    aberturas: {
      suspeita_de_opt_out: ["समझ गया। अब मैं यहाँ स्वचालित संदेश भेजना बंद कर दूँगा।"],
      pediu_humano: ["ज़रूर। मैंने टीम के एक सदस्य को आपसे बात करने के लिए सूचित कर दिया है।"],
      orcamento_de_ia: ["मैं आपकी बातचीत टीम के एक सदस्य को सौंप रहा हूँ।"],
      outro: ["इस मामले में टीम का कोई सदस्य बेहतर सहायता कर सकता है। मैंने उन्हें सूचित कर दिया है।"],
    },
    fechos: {
      sem_equipe: ["आपका अनुरोध दर्ज हो गया है; टीम जल्द से जल्द जवाब देगी।"],
      fora_de_expediente: ["अभी कोई उपलब्ध नहीं है, लेकिन आपका अनुरोध टीम की कतार में है।"],
      com_equipe: ["कृपया इसी बातचीत में बने रहें; कोई जल्द जवाब देगा।"],
    },
    confirmacaoOptOut: "पुष्टि के लिए आपका अनुरोध टीम के एक सदस्य को भेज दिया है।",
  },
  tamil: {
    aberturas: {
      suspeita_de_opt_out: ["புரிந்தது. இனி இங்கே தானியங்கி செய்திகளை அனுப்ப மாட்டேன்."],
      pediu_humano: ["நிச்சயமாக. உங்களுடன் பேச குழுவில் ஒருவருக்கு தெரிவித்துள்ளேன்."],
      orcamento_de_ia: ["உங்கள் உரையாடலை குழுவில் ஒருவரிடம் மாற்றுகிறேன்."],
      outro: ["இதில் குழுவில் ஒருவர் உதவுவது சிறந்தது. அவர்களுக்கு தெரிவித்துள்ளேன்."],
    },
    fechos: {
      sem_equipe: ["உங்கள் கோரிக்கை பதிவு செய்யப்பட்டது; குழு விரைவில் பதிலளிக்கும்."],
      fora_de_expediente: ["இப்போது யாரும் கிடைக்கவில்லை; உங்கள் கோரிக்கை குழுவின் வரிசையில் சேர்க்கப்பட்டது."],
      com_equipe: ["இந்த உரையாடலில் காத்திருக்கவும்; ஒருவர் விரைவில் பதிலளிப்பார்."],
    },
    confirmacaoOptOut: "உறுதிப்படுத்த உங்கள் கோரிக்கையை குழுவில் ஒருவருக்கு அனுப்பியுள்ளேன்.",
  },
};

function textosDoIdioma(idioma: ReplyLanguage): TextosDoAviso {
  return idioma === "undetermined" ? TEXTOS_POR_IDIOMA.portuguese : TEXTOS_POR_IDIOMA[idioma];
}

/**
 * Variante DETERMINÍSTICA por lead: sha256(lead_id) → uint32 → módulo.
 *
 * É a MESMA regra de `pickReentryVariant` (`lib/agent-engine/agent/reentry-template.ts`),
 * reescrita aqui em vez de importada porque aquela vive no motor (`agent-engine`)
 * e este módulo é dos DOIS mundos — o do CRM não pode importar do motor sem
 * arrastar `pg` para dentro de uma rota Next.
 */
function variante<T>(leadId: string, opcoes: readonly T[]): T {
  const digest = createHash("sha256").update(leadId).digest();
  return opcoes[digest.readUInt32BE(0) % opcoes.length]!;
}

/**
 * O que o cliente lê. Uma frase, sem jargão, sem prometer o que não se cumpre.
 *
 * `quem` é `null` quando a leitura de disponibilidade falhou — e aí a frase é a
 * conservadora, pelo mesmo motivo de `expectativaDeAtendimento`: errar para o
 * lado de prometer menos é recuperável; prometer o que não se cumpre, não.
 *
 * `leadId` entra SÓ como semente do sorteio — nada dele aparece no texto. O nome
 * do contato também não: o aviso sai por um caminho determinístico, sem modelo, e
 * uma saudação montada em código ("Oi, {nome}!") em cima de uma conversa já em
 * andamento soa a robô — que é exatamente o que ele é, mas não precisa parecer
 * duas vezes.
 */
export function textoDoAviso(
  motivo: MotivoDoAviso,
  quem: QuemPodeAssumir | null,
  leadId: string,
  idioma: ReplyLanguage = "undetermined",
): string {
  const textos = textosDoIdioma(idioma);
  const abertura = variante(leadId, textos.aberturas[motivo]);

  if (motivo === "suspeita_de_opt_out") {
    // Sem fecho de expediente: quem pediu para parar não está esperando
    // atendimento, então "aguarde um instante" seria a resposta errada à
    // pergunta que ele fez.
    return `${abertura} ${textos.confirmacaoOptOut}`;
  }

  const fecho =
    quem === null || quem.total === 0
      ? variante(leadId, textos.fechos.sem_equipe)
      : quem.disponiveis === 0
        ? variante(leadId, textos.fechos.fora_de_expediente)
        : variante(leadId, textos.fechos.com_equipe);

  return `${abertura} ${fecho}`;
}
