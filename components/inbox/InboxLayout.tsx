"use client";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api/client";
import { ApiError } from "@/lib/api/types";
import { DEMO_WEB_CHANNEL } from "@/lib/channels/demo-web-ingress";
import { useDemoWebPresentation } from "@/lib/i18n/IdiomaProvider";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/hooks/auth/AuthProvider";
import { estadoDaJanela, formatarDecorrido } from "@/lib/channels/janela";
import { JanelaFechadaAviso } from "@/components/inbox/JanelaFechadaAviso";
import { useClaimConversation } from "@/hooks/inbox/useClaimConversation";
import { useCloseConversation } from "@/hooks/inbox/useCloseConversation";
import { useMarkAsRead } from "@/hooks/inbox/useMarkAsRead";
import {
  useConversationsRealtime,
  type ConversationsFilters,
  type ConversationWithContact,
} from "@/hooks/inbox/useConversationsRealtime";
import { useConversation, isNotFound } from "@/hooks/inbox/useConversation";
import { ConversationList } from "./ConversationList";
import { ConversationListItem } from "./ConversationListItem";
import { MessageBubble } from "./MessageBubble";
import { InboxFilters, type InboxFiltersValue, type InboxTab } from "./InboxFilters";
import { ChatThread } from "./ChatThread";
import { Composer, type ComposerHandle } from "./Composer";
import { ConversationHeader } from "./ConversationHeader";
import { RetentionNotice } from "./RetentionNotice";
import { CRMSidePanel } from "./CRMSidePanel";
import type { Message as ConversationMensagem } from "@/lib/types/messaging";
import { InboxKeyboardShortcuts } from "./InboxKeyboardShortcuts";

import { ShortcutsHelpDialog } from "./ShortcutsHelpDialog";
import { OpenConversationProvider } from "@/hooks/notifications/OpenConversationContext";
// ADR-05: ícone de feature sai do mapa canônico, nunca do pacote direto.
import { CaretLeft, ChatCircle, IdentificationCard } from "@/lib/ui/icons";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { comandosDaFila } from "@/lib/inbox/comando-da-conversa";
import { buscaValeConsulta } from "@/lib/inbox/termo-de-busca";
import { useAutomaticoAtivo } from "@/hooks/ai/useAutomaticoAtivo";

/**
 * QUAL COLUNA APARECE NO CELULAR — as duas saem da MESMA pergunta.
 *
 * Abaixo do `md` só cabe uma coluna por vez, então a lista e a conversa se
 * alternam. O defeito que esta função existe para tornar impossível é as duas
 * decidirem por dados DIFERENTES: a lista somia com `selectedId` (o id) e a
 * conversa aparecia com `selectedConversation` (o objeto já carregado). Entre
 * uma coisa e a outra existe uma janela em que nenhuma das duas aparece — e
 * essa janela tem dois casos reais no telefone:
 *
 *   1. o deep-link `/inbox/<id>`, enquanto a busca única ainda responde;
 *   2. a conversa fora do acesso, que é estado PERMANENTE — e cuja mensagem
 *      ("Conversa não encontrada") ficava escondida junto, deixando o dono
 *      numa tela branca sem nem o botão de voltar.
 *
 * Com uma pergunta só, "as duas escondidas" deixa de ser representável.
 * `md:flex` em ambas: no desktop as duas colunas convivem e a regra não vale.
 */
export function colunasDoCelular(temSelecao: boolean): { lista: string; conversa: string } {
  return {
    lista: temSelecao ? "hidden md:flex" : "flex",
    conversa: temSelecao ? "flex" : "hidden md:flex",
  };
}

/**
 * O QUE CADA ABA SIGNIFICA. Exportada porque é a definição em si — o defeito
 * que este mapa já teve (Minhas mostrando tudo que o atendente fechou) não
 * aparece em nenhuma tela até alguém reclamar, então vale prender por teste.
 */
export function tabToFilter(
  tab: InboxFiltersValue["tab"],
  automaticoDaOrg?: boolean,
): Partial<ConversationsFilters> {
  switch (tab) {
    case "unassigned":
      // A FILA PERGUNTA POR QUEM MANDA, NÃO POR STATUS.
      //
      // Antes ela pedia `assigned_to=unassigned` + os dois estados de espera. Só
      // que "sem dono e aberta" é também a conversa que o robô está atendendo
      // agora — medido na VPS em 2026-08-30, a aba dizia 83 e 47 daquelas tinham
      // o automático no comando. O atendente abria a Fila e via como trabalho
      // dele quase tudo que já estava sendo respondido.
      //
      // `comandosDaFila` é quem cruza isso com o fato org-wide: numa instalação
      // sem nenhum agente no ar, `automatico` também é "esperando gente".
      return { comando: comandosDaFila(automaticoDaOrg) };
    case "mine":
      // Sem `exclude_finished` a aba mostra tudo que o atendente JÁ atendeu —
      // `Fechar` muda o status mas não solta o dono (de propósito: quem atendeu
      // é histórico). O lugar de "minhas fechadas" é a aba Fechadas.
      return { assigned_to: "me", exclude_finished: true };
    case "closed":
      return { status: "closed" };
    case "archived":
      // O ARQUIVO É UM ESTADO SÓ ELE, não `in(terminais)`.
      //
      // `CONVERSATION_TERMINAL_STATUSES` responde outra pergunta ("o que sai do
      // fluxo vivo", usada pelo `exclude_finished` de Minhas). Reaproveitá-la
      // aqui faria a aba Arquivadas listar também as fechadas — duas abas com a
      // mesma lista e badges diferentes, que é a mentira de tela que o mapa
      // abaixo existe para impedir.
      return { status: "archived" };
    case "ai":
      // `ai_handling` é escrito por UM caminho só em produção (a volta pelo botão
      // "Devolver ao automático"), então a aba vivia mostrando 2 enquanto o robô
      // atendia 47. Agora ela pergunta a régua do MOTOR.
      return { comando: ["automatico"] };
    case "all":
    default:
      return {};
  }
}

const FILTER_TABS: InboxTab[] = ["unassigned", "mine", "all", "closed", "archived", "ai"];

/**
 * Lê ?filter= (G4-02, deep-link). ?filter=all é HONRADO mesmo para agent — a
 * lista volta RLS-scoped (a tab só some cosmeticamente); default: fila.
 */
function parseFilterParam(v: string | null): InboxTab {
  return v && FILTER_TABS.includes(v as InboxTab) ? (v as InboxTab) : "unassigned";
}

interface InboxLayoutProps {
  initialSelectedId?: string | null;
}

export function InboxLayout(props: InboxLayoutProps = {}) {
  const demo = useDemoWebPresentation();
  return demo ? <DemoInbox key={props.initialSelectedId ?? "list"} {...props} /> : <NormalInboxLayout {...props} />;
}
function NormalInboxLayout({ initialSelectedId = null }: InboxLayoutProps = {}) {
  const t = useT();
  const { activeOrg, user } = useAuth();
  const supportReadonly = user.support?.access_mode === "support_readonly";
  const orgId = activeOrg?.orgId ?? null;

  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab = parseFilterParam(searchParams.get("filter"));

  // tab vive na URL (?filter=); os demais filtros são estado local de sessão.
  const [aux, setAux] = useState<Omit<InboxFiltersValue, "tab">>({
    search: "",
    onlyUnread: false,
  });
  const filterValue: InboxFiltersValue = { tab, ...aux };
  const setFilterValue = useCallback(
    (next: InboxFiltersValue) => {
      if (next.tab !== tab) {
        const params = new URLSearchParams(searchParams);
        params.set("filter", next.tab);
        router.replace(`${pathname}?${params.toString()}`, { scroll: false });
      }
      const { tab: _t, ...rest } = next;
      setAux(rest);
    },
    [tab, searchParams, router, pathname],
  );

  // Desliga só os AUXILIARES e mantém a aba: a aba é onde a pessoa está, e
  // limpá-la junto a tiraria do lugar sem ela ter pedido.
  const limparFiltrosAuxiliares = useCallback(() => {
    setFilterValue({ tab, search: "", onlyUnread: false });
  }, [tab, setFilterValue]);

  const [selectedId, setSelectedId] = useState<string | null>(initialSelectedId);
  const [visibleIds, setVisibleIds] = useState<string[]>([]);
  const [helpOpen, setHelpOpen] = useState(false);
  /** A ficha do contato como painel deslizante — só existe abaixo do `xl`. */
  const [fichaAberta, setFichaAberta] = useState(false);
  /**
   * A mensagem escolhida para responder "em cima".
   *
   * Mora aqui, e não no composer, porque quem ESCOLHE é a lista de mensagens e
   * quem MOSTRA é o composer — são irmãos, e o estado comum é do pai.
   */
  const [respondendo, setRespondendo] = useState<ConversationMensagem | null>(null);

  /**
   * A ORG tem automático de pé? Sobe para cá porque agora é a ABA que precisa —
   * `ConversationList` e `ConversationHeader` continuam lendo o mesmo hook, e o
   * react-query dedupa: segue sendo uma requisição só.
   *
   * `undefined` enquanto carrega, e `comandosDaFila` trata isso como "assume que
   * há" — a mesma convenção da regra. Numa org SEM automático a Fila nasce menor
   * e completa quando a resposta chega; a janela é de ~200ms e o rótulo nunca
   * discorda do filtro, porque os dois usam a mesma convenção.
   */
  const { data: automaticoDaOrg } = useAutomaticoAtivo();
  const composerRef = useRef<ComposerHandle | null>(null);

  const filters: ConversationsFilters = useMemo(
    () => ({
      ...tabToFilter(filterValue.tab, automaticoDaOrg),
      // A tela NÃO pede o que a rota recusa: o hook trata falha com
      // `showApiError`, então digitar a primeira letra de qualquer busca faria
      // piscar um erro na cara de quem digita. A regra é a MESMA que o schema
      // usa (`lib/inbox/termo-de-busca.ts`) — nunca repetida aqui.
      search: buscaValeConsulta(filterValue.search)
        ? filterValue.search
        : undefined,
      channel_session_id: filterValue.channel_session_id,
      tag: filterValue.tag,
      unread: filterValue.onlyUnread || undefined,
    }),
    [
      filterValue.tab,
      automaticoDaOrg,
      filterValue.search,
      filterValue.channel_session_id,
      filterValue.tag,
      filterValue.onlyUnread,
    ],
  );


  // We need the selected conversation object for header / composer / side panel.
  // Source it from the same query the list uses to avoid an extra request.
  const listQ = useConversationsRealtime(filters, orgId);
  const inList = useMemo(() => {
    const all = listQ.data?.pages.flatMap((p) => p.data) ?? [];
    return all.find((c) => c.id === selectedId) ?? null;
  }, [listQ.data, selectedId]);

  // Deep-link para conversa fora do filtro atual (ou fora do escopo do agent):
  // busca única RLS-scoped. 404/vazio ⇒ inacessível ⇒ estado vazio claro (GAP D),
  // nunca stack trace. A RLS (G4-01) é quem garante o não-vazamento.
  //
  // ⚠️ ELA NÃO ESPERA A LISTA — e a espera custava DUAS voltas de rede inteiras.
  //
  // A condição tinha um terceiro termo, `&& !listQ.isLoading`, para poupar uma
  // requisição quando a conversa fosse aparecer na lista de qualquer jeito. O
  // preço real, medido no trace do CI (run 34226618108, deep-link para uma
  // conversa FECHADA — que nenhuma aba da Fila devolve, então a busca única é a
  // única fonte do objeto):
  //
  //   46.725  GET conversations?comando=aguardando               1091ms
  //   48.275  GET conversations?comando=aguardando,automatico     896ms
  //   49.183  GET conversations/<id>                              565ms
  //   49.775  GET contacts/<id>/crm-summary                    (>1034ms)
  //
  // São QUATRO idas em série depois do documento. A lista é pedida duas vezes
  // porque a `queryKey` muda quando `useAutomaticoAtivo` responde (ver
  // `comandosDaFila`), e `isLoading` volta a ser verdadeiro na chave nova — ou
  // seja, o gate segurava a busca única até a SEGUNDA lista assentar, e só
  // então o painel do contato podia começar a carregar. O painel do contato
  // aparecia ~4,7s depois da navegação, e é assim que `encerramento-atendimento`
  // ficou intermitente: a Memória do contato chegava ~0,1–0,6s DEPOIS dos 5s da
  // asserção (o screenshot de falha, tirado logo em seguida, já a mostra).
  //
  // Sem o gate, a busca única sai na primeira leva, em paralelo com a lista, e o
  // objeto existe uma volta depois do documento em vez de três. O custo é UMA
  // requisição extra por deep-link cuja conversa acabe aparecendo na lista —
  // clicar numa conversa da lista já carregada continua sem pedir nada, porque
  // aí `inList` já a tem no primeiro render.
  const needsFetch = !!selectedId && !inList;
  const single = useConversation(selectedId, needsFetch);
  const selectedConversation: ConversationWithContact | null = inList ?? single.data ?? null;
  const selectionNotFound =
    needsFetch && !single.isPending && !single.data && isNotFound(single.error);

  const colunas = colunasDoCelular(Boolean(selectedId));

  const claim = useClaimConversation();
  const close = useCloseConversation();

  // A leitura da conversa aberta é do upstream e fica: sem ela o contador de
  // não-lidas nunca zera para quem abre a conversa.
  useMarkAsRead(
    selectedConversation?.id ?? null,
    selectedConversation?.unread_count_for_assignee ?? 0,
  );

  // Aceita `null`: é o VOLTAR do celular, que limpa a seleção e devolve a lista.
  // É um SUPERCONJUNTO do `handleSelect` do upstream — o tipo dele não aceita
  // `null`, e sem isso o botão de voltar não teria o que chamar.
  //
  // A seleção NÃO vive na URL (só o `?filter=` vive) — então este voltar é
  // estado local, e o botão de voltar do navegador não desfaz a seleção. É a
  // limitação conhecida deste caminho; trocar por URL mudaria o deep-link de
  // conversa, que hoje entra por `initialSelectedId` vindo da rota.
  const handleSelect = useCallback((id: string | null) => {
    setSelectedId(id);
    // Sem isto, escolher "responder" numa conversa e trocar para outra levaria
    // a citação junto — e a resposta sairia citando mensagem de outro cliente.
    setRespondendo(null);
  }, []);
  const handleVisibleChange = useCallback((ids: string[]) => setVisibleIds(ids), []);
  const handleFocusReply = useCallback(() => composerRef.current?.focus(), []);
  const handleClaim = useCallback(() => {
    if (!selectedConversation) return;
    claim.mutate({
      conversation_id: selectedConversation.id,
      expected_assignee: selectedConversation.assigned_to_user_id,
    });
  }, [claim, selectedConversation]);
  const handleClose = useCallback(() => {
    if (!selectedConversation) return;
    close.mutate({ conversation_id: selectedConversation.id });
  }, [close, selectedConversation]);

  // A janela vence SOZINHA com a aba aberta. Sem este relógio, quem deixa o
  // inbox aberto a tarde inteira seguiria com o composer liberado numa conversa
  // que já venceu — e o bloqueio só apareceria no próximo recarregamento.
  const [agoraJanela, setAgoraJanela] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setAgoraJanela(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  // A janela de 24h fecha o composer, e o motivo DIZ há quanto tempo fechou.
  //
  // Antes disto o texto livre saía, o CRM marcava `failed` e o operador via um
  // `131047` — descobrindo a regra pelo erro, uma mensagem por vez. Barrar aqui
  // é o pedido explícito do dono: se não dá para enviar, que não deixe tentar.
  //
  // Reusa o `blockedReason` que já existe (contato bloqueado/anonimizado) em vez
  // de um segundo mecanismo de bloqueio: dois caminhos para desabilitar o mesmo
  // composer divergem, e o segundo esquece de cobrir o áudio ou o anexo.
  const janela = estadoDaJanela(
    selectedConversation?.channel_sessions?.provider ?? null,
    selectedConversation?.last_inbound_at ?? null,
    agoraJanela,
  );
  const motivoDaJanela =
    janela.tipo === "fechada"
      ? janela.fechadaHaMs === null
        ? t("O cliente ainda não escreveu — a janela de 24h nunca abriu. Só um modelo aprovado sai daqui.")
        : `${t("A janela de 24h fechou há")} ${formatarDecorrido(janela.fechadaHaMs)}. ${t("Só um modelo aprovado sai daqui — texto livre é recusado pela plataforma.")}`
      : null;

  const blockedReason = selectedConversation?.contacts?.is_blocked
    ? t("Contato bloqueado — envio de mensagens desabilitado.")
    : selectedConversation?.contacts?.is_anonymized
      ? t("Contato anonimizado — não é possível enviar mensagens.")
      : null;

  // Altura da grade: a conta desconta TUDO que fica acima e abaixo dela.
  //   3.5rem            TopBar (`h-14`, em components/shell/TopBar.tsx)
  //   2 * --space-6     padding do <main> do AppShell (`p-6`, em cima e embaixo)
  //
  // Com `100vh-3.5rem` o padding ficava de fora e a grade media 48px a MAIS que a
  // tela. Quem pagava a diferença era o composer, que fica no rodapé: nascia
  // parcialmente abaixo da borda, atrapalhando justo na hora de escrever.
  //
  // As duas parcelas NÃO estão na mesma unidade, e por isso o padding entra pelo
  // token e não como `3rem`: o `@theme inline` de `app/globals.css` remapeia a
  // escala de spacing para `var(--space-N)` — `--space-6` é `24px` LITERAL —, mas
  // não remapeia o `14`, que o Tailwind 4 calcula pelo multiplicador `--spacing`
  // e segue sendo `3.5rem` de verdade. (Até o Tailwind 4 quem remapeava era o
  // `tailwind.config.ts`; o arquivo não existe mais, o efeito é o mesmo.)
  // Escrever a soma como
  // `6.5rem` só acerta enquanto a raiz for 16px; com acessibilidade de fonte maior
  // ou menor o composer sai da tela de novo. Pelo token, a conta se auto-corrige
  // se a escala de espaçamento mudar.
  //
  // `dvh` em vez de `vh` porque no celular a `vh` ignora a barra do navegador — o
  // mesmo corte, só que pior e mudando conforme se rola a página.

  // TRÊS COLUNAS QUE CABEM — medido, não estimado.
  //
  // O `xl` do Tailwind dispara em 1280px, e era ali que a terceira coluna
  // nascia: no ponto exato em que não havia espaço para ela. Com a barra de
  // navegação (240px) sobram 1040px, e o grid pedia 300 + 707 + 320 = 1327 —
  // o painel de CRM ficava 311px FORA da viewport, alcançável só rolando o
  // `main` de lado, que ninguém faz. Em 1280 o atendente simplesmente não via
  // contexto nenhum do cliente.
  //
  // Os 707px eram o `min-content` do `ConversationHeader` (a barra de ações
  // era `shrink-0`), e `1fr` é `minmax(auto, 1fr)`: não encolhe abaixo disso.
  // Consertado o header, o `1fr` volta a encolher sozinho — `minmax(0,1fr)`
  // foi medido aqui e não mudou um pixel, então não entrou.
  //
  // Duas faixas em vez de uma: compacta onde aperta, generosa onde há espaço.
  // Em 1280 isso dá 424px de conversa em vez de 372 — 54px de folga sobre o
  // piso do composer (370px), em vez dos 2px que a versão de uma faixa só
  // deixava. Margem de 2px não é margem, é sorte.
  return (
    <OpenConversationProvider conversationId={selectedId}>
    <div
      className="grid h-[calc(100dvh-3.5rem-2*var(--space-6))] w-full grid-cols-1 md:grid-cols-[300px_1fr] xl:grid-cols-[272px_1fr_296px] 2xl:grid-cols-[300px_1fr_320px]"
      /*
       * O ESTADO DO TEMPO REAL, LEGÍVEL DE FORA — mesmo par que o dossiê do lead
       * já publica (`LeadDossier`), e pela mesma razão: quando a entrega morre,
       * nenhuma tela avisa. Foi o único achado que atravessou o dia intacto
       * quando o realtime quebrou pela primeira vez, e voltou a morder agora.
       *
       * `divergencias` é o que a rede de segurança contou: refetch trouxe estado
       * novo que o canal NÃO tinha entregue. Zero com o canal vivo; subindo é a
       * assinatura de canal que assina e não entrega — o defeito que não grita.
       *
       * ⚠️ `data-realtime-status` vem do STATUS do canal, não de um objeto que
       * existe sempre. A primeira versão desta linha derivava o valor de
       * `listQ.seguranca`, que nunca é nulo — ela diria `ativo` inclusive com o
       * canal morto. Controle decorativo é pior que controle nenhum: mente com
       * cara de instrumento.
       *
       * Atributo de dado e não texto na tela de propósito: quem lê isto é o
       * teste e quem depura, não o atendente. Pôr um aviso permanente na cara de
       * quem atende seria ruído; esconder o sinal do todo é o que custou o dia.
       */
      data-realtime-status={listQ.realtimeStatus}
      data-refetch-divergencias={listQ.seguranca?.divergencias ?? 0}
    >
      {/*
        NO CELULAR, UMA COISA POR VEZ.

        Antes as duas colunas caíam empilhadas em `grid-cols-1`: a lista inteira
        primeiro e a conversa DEPOIS dela. Para responder era preciso rolar a
        lista toda até o fim, e o composer ficava fora da tela — que é o
        "incômodo" relatado por quem atende do telefone.

        Sem media query em JavaScript de propósito: `useMediaQuery` decide DEPOIS
        da hidratação, então a primeira pintura mostra o layout errado e pisca. A
        classe condicional é resolvida pelo CSS, na primeira pintura, e some no
        `md` — onde as duas colunas cabem juntas e a regra não se aplica.
      */}
      <div
        className={cn(
          "h-full min-h-0 flex-col border-r border-border md:flex",
          colunas.lista,
        )}
      >
        <InboxFilters value={filterValue} onChange={setFilterValue} />
        <div className="min-h-0 flex-1 overflow-hidden">
          <ConversationList
            listQuery={listQ}
            filters={filters}
            selectedId={selectedId}
            onSelect={handleSelect}
            onVisibleChange={handleVisibleChange}
            onLimparFiltros={limparFiltrosAuxiliares}
          />
        </div>
      </div>

      {/*
        AS DUAS COLUNAS DECIDEM PELO MESMO DADO — `selectedId`, não o objeto.

        A da lista some quando há `selectedId`; se esta aparecesse só quando a
        conversa já está CARREGADA, a janela entre as duas coisas não mostra
        nenhuma das colunas. No celular isso é a tela em branco, e ela tem dois
        casos reais: o instante do deep-link `/inbox/<id>`, enquanto a busca
        única ainda responde; e o estado permanente de conversa fora do acesso,
        cuja mensagem ("Conversa não encontrada") é justamente o que ficava
        escondido — deixando o dono numa tela vazia, sem sequer o botão de
        voltar, porque ele morava dentro do ramo da conversa carregada.
      */}
      <div
        className={cn(
          "h-full min-h-0 flex-col md:flex",
          colunas.conversa,
        )}
      >
        {/*
          A barra do celular vive FORA do ramo da conversa carregada: o caminho
          de volta tem de existir inclusive quando não há o que mostrar — é aí
          que ele é a única saída. A porta da ficha, essa sim, depende da
          conversa, e só aparece quando há uma.
        */}
        {selectedId && (
          <div className="flex items-center gap-1 border-b border-border px-1 py-1 md:hidden">
            <Button
              variant="ghost"
              size="sm"
              className="h-9 gap-1 px-2"
              onClick={() => handleSelect(null)}
            >
              <CaretLeft size={16} />
              {t("Conversas")}
            </Button>
            <div className="flex-1" />
            {selectedConversation && (
              <Sheet open={fichaAberta} onOpenChange={setFichaAberta}>
                <SheetTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-9 gap-1 px-2 xl:hidden">
                    <IdentificationCard size={16} />
                    {t("Ficha")}
                  </Button>
                </SheetTrigger>
                <SheetContent side="right" className="w-[min(22rem,90vw)] overflow-y-auto p-0">
                  <SheetTitle className="sr-only">{t("Ficha do contato")}</SheetTitle>
                  <CRMSidePanel conversation={selectedConversation} />
                </SheetContent>
              </Sheet>
            )}
          </div>
        )}
        {selectedConversation ? (
          <>
            <ConversationHeader conversation={selectedConversation} />
            <div className="min-h-0 flex-1 overflow-hidden">
              <ChatThread
                conversationId={selectedConversation.id}
                onResponder={setRespondendo}
                // O cartão da passagem escolhe o gesto a partir de quem é o dono
                // da conversa: sem dono convida a assumir, com outro dono diz
                // quem atende. Sem estes dois campos ele cairia no estado mais
                // conservador e ficaria mudo justamente para quem mais precisa.
                dono={{
                  userId: selectedConversation.assigned_to_user_id ?? null,
                  nome: selectedConversation.assigned_to_user_name ?? null,
                }}
                contatoId={selectedConversation.contacts?.id ?? null}
              />
            </div>
            <RetentionNotice conversationId={selectedConversation.id} />
            {motivoDaJanela && (
              <JanelaFechadaAviso
                conversationId={selectedConversation.id}
                provider={selectedConversation.channel_sessions?.provider ?? null}
                motivo={motivoDaJanela}
              />
            )}
            <Composer
              ref={composerRef}
              conversationId={selectedConversation.id}
              blockedReason={supportReadonly ? "Acompanhamento somente leitura" : blockedReason}
              janelaFechada={motivoDaJanela}
              disabled={selectedConversation.status === "closed"}
              contactName={selectedConversation.contacts?.name ?? null}
              respondendo={respondendo}
              onCancelarResposta={() => setRespondendo(null)}
              currentContactId={selectedConversation.contact_id}
            />
          </>
        ) : selectionNotFound ? (
          <div className="flex h-full items-center justify-center px-6 text-center text-sm text-muted-foreground">
            {t("Conversa não encontrada ou fora do seu acesso.")}
          </div>
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
            <ChatCircle size={36} weight="thin" className="text-text-subtle" aria-hidden />
            <p className="text-sm font-medium text-text-muted">{t("Selecione uma conversa")}</p>
            <p className="text-xs text-text-muted">{t("Ou navegue com J e K")}</p>
          </div>
        )}
      </div>

      <div className="hidden h-full min-h-0 xl:block">
        <CRMSidePanel conversation={selectedConversation} />
      </div>

      <InboxKeyboardShortcuts
        visibleIds={visibleIds}
        selectedId={selectedId}
        onSelect={handleSelect}
        onFocusReply={handleFocusReply}
        onClaim={supportReadonly ? () => {} : handleClaim}
        onClose={supportReadonly ? () => {} : handleClose}
        onToggleHelp={() => setHelpOpen((v) => !v)}
      />
      <ShortcutsHelpDialog open={helpOpen} onOpenChange={setHelpOpen} />
    </div>
    </OpenConversationProvider>
  );
}

// Não monta nenhum filho do Inbox operacional. O servidor continua sendo a
// autoridade de sessão/tenant/canal; estas conferências só evitam exibir um
// resultado inconsistente ou reaproveitar cache de outra organização.
const DEMO_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const demoPolling = (query: { state: { error: Error | null } }) =>
  query.state.error instanceof ApiError && [401, 403, 404].includes(query.state.error.status)
    ? false as const : 15_000;
type DemoPage<T> = { data: T[]; meta?: { cursor?: string | null; has_more?: boolean } };

function DemoInbox({ initialSelectedId = null }: InboxLayoutProps) {
  const { activeOrg, user } = useAuth();
  const org = activeOrg?.orgId;
  const [selected, setSelected] = useState(initialSelectedId);
  const eligible = Boolean(org && !user.support);
  const selectedValid = Boolean(selected && DEMO_UUID.test(selected));
  const checkedConversation = (c: ConversationWithContact) => {
    if (c.organization_id !== org || c.channel_session_id !== DEMO_WEB_CHANNEL || !DEMO_UUID.test(c.id))
      throw new Error("Conversation access could not be verified.");
    return c;
  };
  const list = useInfiniteQuery({
    queryKey: ["demo-inbox", user.id, org, "list"], enabled: eligible,
    initialPageParam: undefined as string | undefined, retry: false,
    refetchInterval: demoPolling, refetchIntervalInBackground: false, refetchOnWindowFocus: false,
    queryFn: async ({ pageParam, signal }) => {
      const qs = new URLSearchParams({ channel_session_id: DEMO_WEB_CHANNEL, limit: "50" });
      if (pageParam) qs.set("cursor", pageParam);
      const page = await apiClient.get<DemoPage<ConversationWithContact>>(`/api/v1/conversations?${qs}`, { signal });
      page.data.forEach(checkedConversation);
      return page;
    },
    getNextPageParam: (page) => page.meta?.has_more ? page.meta.cursor ?? undefined : undefined,
  });
  const detail = useQuery({
    queryKey: ["demo-inbox", user.id, org, "detail", selected], enabled: eligible && selectedValid,
    retry: false, refetchInterval: demoPolling, refetchIntervalInBackground: false, refetchOnWindowFocus: false,
    queryFn: async ({ signal }) => {
      const res = await apiClient.get<{ data: ConversationWithContact }>(`/api/v1/conversations/${selected}`, { signal });
      if (res.data.id !== selected) throw new Error("Conversation access could not be verified.");
      return checkedConversation(res.data);
    },
  });
  const messages = useInfiniteQuery({
    queryKey: ["demo-inbox", user.id, org, "messages", selected],
    enabled: eligible && selectedValid && !!detail.data && !detail.isError,
    initialPageParam: undefined as string | undefined, retry: false,
    refetchInterval: demoPolling, refetchIntervalInBackground: false, refetchOnWindowFocus: false,
    queryFn: async ({ pageParam, signal }) => {
      const qs = new URLSearchParams({ limit: "50" });
      if (pageParam) qs.set("cursor", pageParam);
      const page = await apiClient.get<DemoPage<ConversationMensagem>>(`/api/v1/conversations/${selected}/messages?${qs}`, { signal });
      if (page.data.some(m => m.organization_id !== org || m.channel_session_id !== DEMO_WEB_CHANNEL ||
          m.conversation_id !== selected || m.contact_id !== detail.data?.contact_id || !Number.isFinite(Date.parse(m.sent_at))))
        throw new Error("Message access could not be verified.");
      return page;
    },
    getNextPageParam: page => page.meta?.has_more ? page.meta.cursor ?? undefined : undefined,
  });
  const conversations = Array.from(new Map(list.data?.pages.flatMap(p => p.data).map(c => [c.id, c])).values());
  const ordered = Array.from(new Map(messages.data?.pages.flatMap(p => p.data).map(m => [m.id, m])).values())
    .sort((a, b) => Date.parse(a.sent_at) - Date.parse(b.sent_at) || a.id.localeCompare(b.id));
  if (!eligible) return <p role="alert">An authenticated organization is required.</p>;
  return <section aria-label="Read-only demo Inbox" className="space-y-3">
    <p>Read-only viewer. Messages appear when stored by the channel or Worker; this view does not send replies.</p>
    <div className="grid min-h-[32rem] gap-4 md:grid-cols-[minmax(14rem,1fr)_2fr] xl:grid-cols-[minmax(14rem,1fr)_2fr_minmax(12rem,1fr)]">
      <nav aria-label="Conversations" className="space-y-2">
        {list.isPending ? <p role="status">Loading conversations…</p> : list.isError ?
          <p role="alert">Unable to load conversations. Your session or access may have changed.</p> : <>
            {!conversations.length && <p>No conversations yet.</p>}
            {conversations.map(c => <ConversationListItem key={c.id} conversation={c}
              isSelected={selected === c.id} onSelect={setSelected} showAvatarImage={false} />)}
            {list.hasNextPage && <button disabled={list.isFetching} onClick={() => { void list.fetchNextPage({ cancelRefetch: false }); }}>More conversations</button>}
          </>}
      </nav>
      <div aria-label="Conversation messages" className="min-w-0 rounded border bg-muted/20">
        {detail.data && !detail.isError && <header className="border-b p-4">
          <h2 className="font-semibold">{detail.data.contacts?.display_name || detail.data.contacts?.name || "Customer"}</h2>
          <p className="text-sm text-muted-foreground">0230 · Read-only conversation</p>
        </header>}
        {!selected ? <p>Select a conversation.</p> : !selectedValid ? <p role="alert">Invalid conversation.</p> :
          detail.isError ? <p role="alert">Conversation unavailable or outside your access.</p> :
          detail.isPending || messages.isPending ? <p role="status">Loading messages…</p> :
          messages.isError ? <p role="alert">Unable to load messages. Your session or access may have changed.</p> : <>
            {!ordered.length && <p>No messages yet.</p>}
            {messages.hasNextPage && <button disabled={messages.isFetching} onClick={() => { void messages.fetchNextPage({ cancelRefetch: false }); }}>Older messages</button>}
            <ol aria-label="Message history" className="max-h-[65vh] overflow-y-auto py-3">{ordered.map((m, index) => <li key={m.id}>
              {(index === 0 || ordered[index - 1]?.sent_at.slice(0, 10) !== m.sent_at.slice(0, 10)) &&
                <p className="my-3 text-center text-xs"><time dateTime={m.sent_at.slice(0, 10)}>{new Date(m.sent_at).toLocaleDateString("en-US", { timeZone: "UTC", dateStyle: "long" })}</time></p>}
              <p className={cn("px-4 text-xs text-muted-foreground", m.direction === "outbound" && "text-right")}>
                {m.direction === "inbound" ? "Customer" : m.sent_via === "ai" ? "AI reply" :
                  m.sent_via === "user" || m.sent_via === "crm" ? "Human reply" : "Outbound message"}
              </p>
              <MessageBubble message={m} readOnly viewerUserId={user.id}
                citada={m.reply_to_message_id ? ordered.find(item => item.id === m.reply_to_message_id) : null} />
            </li>)}</ol>
          </>}
      </div>
      {detail.data && !detail.isError && <aside aria-label="Lead details" className="space-y-3 rounded border p-4">
        <h2 className="font-semibold">Lead details</h2>
        <dl className="space-y-2 text-sm">
          <div><dt className="text-muted-foreground">Name</dt><dd>{detail.data.contacts?.display_name || detail.data.contacts?.name || "Not available"}</dd></div>
          <div><dt className="text-muted-foreground">Phone</dt><dd>{detail.data.contacts?.is_anonymized ? "Not available" : detail.data.contacts?.phone_number || "Not available"}</dd></div>
          <div><dt className="text-muted-foreground">Status</dt><dd>{detail.data.status || "Not available"}</dd></div>
          <div><dt className="text-muted-foreground">Assigned attendant</dt><dd>{detail.data.assigned_to_user_name || (detail.data.assigned_to_user_id ? "Name unavailable" : "Unassigned")}</dd></div>
          <div><dt className="text-muted-foreground">Tags</dt><dd>{detail.data.contacts?.tags?.join(", ") || "None"}</dd></div>
        </dl>
        {detail.data.contacts?.is_blocked && <p>Contact blocked</p>}
        {detail.data.contacts?.force_human && <p>Human takeover enabled</p>}
        <p className="text-xs text-muted-foreground">Only details returned by the authorized conversation are shown. Sending and CRM changes are disabled.</p>
      </aside>}
    </div>
  </section>;
}
