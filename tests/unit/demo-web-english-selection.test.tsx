// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdiomaProvider, useT, useAplicarIdioma } from "@/lib/i18n/IdiomaProvider";
import { demoWebPresentation, idiomaDaDemoWeb } from "@/lib/i18n/demo-web";
import { normalizarIdioma, parseAcceptLanguage, IDIOMA_PADRAO } from "@/lib/i18n/idiomas";
import { IDIOMAS_VISIVEIS, idiomaVisivelPorCodigo } from "@/lib/i18n/registro";
import { DICIONARIO, traduzir } from "@/lib/i18n/dicionario";
import { localeDeData } from "@/lib/i18n/datas";
import { DEMO_WEB_CHANNEL } from "@/lib/channels/demo-web-ingress";
import { InboxFilters } from "@/components/inbox/InboxFilters";
import { LoginForm } from "@/components/auth/LoginForm";
import { SeletorDeIdioma } from "@/components/shell/SeletorDeIdioma";
import { NAV_DESTINATIONS, NAV_GROUPS } from "@/lib/navigation/registry";
import catalogo from "@/lib/i18n/traducoes/en-US.json";

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock("@/app/actions/auth/signInWithPassword", () => ({ signInWithPassword: vi.fn() }));
vi.mock("@/app/actions/settings/trocarIdioma", () => ({ trocarIdioma: vi.fn() }));
vi.mock("@/hooks/channels/useChannelSessions", () => ({ useChannelSessions: () => ({ data: [] }), channelLabel: () => "" }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => ({ activeOrg: { orgId: "synthetic", role: "admin", visibility_mode: "all" } }) }));
vi.mock("@/hooks/inbox/useConversationTags", () => ({ useConversationTagVocabulary: () => ({ data: [] }) }));
vi.mock("@/hooks/contacts/useContactTagVocabulary", () => ({ useContactTagVocabulary: () => ({ data: [] }) }));
vi.mock("@/hooks/inbox/useConversationCounts", () => ({ useConversationCounts: () => ({ data: undefined }) }));

beforeEach(() => {
  vi.stubEnv("DEMO_WEB_INGRESS_ONLY", "false");
  vi.stubEnv("DEMO_INBOUND_ONLY", "false");
});
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });
function demo() {
  vi.stubEnv("DEMO_WEB_INGRESS_ONLY", "true");
  vi.stubEnv("DEMO_WEB_CHANNEL_ID", DEMO_WEB_CHANNEL);
}
function ChooseEnglish() {
  const apply = useAplicarIdioma();
  return <button onClick={() => apply("en-US")}>client locale request</button>;
}
function Label() { const t = useT(); return <span>{t("Entrar")}</span>; }

describe("English scoped to the validated demo Web process", () => {
  it("uses English across remount/refresh despite a saved Portuguese preference", () => {
    demo();
    for (let refresh = 0; refresh < 2; refresh++) {
      render(<IdiomaProvider locale="pt-BR" demoPresentation={demoWebPresentation()}>
        <Label /><SeletorDeIdioma />
        <InboxFilters value={{ tab: "all", search: "", onlyUnread: false }} onChange={vi.fn()} />
      </IdiomaProvider>);
      expect(screen.getByText("Sign in")).toBeTruthy();
      expect(screen.getByTestId("seletor-de-idioma").textContent).toBe("EN");
      expect(screen.getByLabelText(traduzir("Buscar conversas", "en-US"))).toBeTruthy();
      expect(screen.getByRole("tab", { name: "All" })).toBeTruthy();
      expect(document.documentElement.lang).toBe("en-US");
      cleanup();
    }
  });
  it("renders the real LoginForm and its denied-request error in English", async () => {
    demo();
    render(<IdiomaProvider locale="pt-BR" demoPresentation={demoWebPresentation()}><LoginForm demoWeb /></IdiomaProvider>);
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "unit@example.invalid" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "synthetic-password" } });
    fireEvent.submit(screen.getByRole("button", { name: "Sign in" }).closest("form")!);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Unexpected error. Try again."));
  });
  it.each([undefined, "false", ""])("does not override ordinary locale selection: %s", (mode) => {
    vi.stubEnv("DEMO_WEB_INGRESS_ONLY", mode);
    expect(idiomaDaDemoWeb()).toBeNull();
    expect(IDIOMA_PADRAO).toBe("pt-BR");
    expect(idiomaVisivelPorCodigo("unknown" as "pt-BR").codigo).toBe("pt-BR");
    expect(normalizarIdioma(null)).toBe("pt-BR");
    expect(normalizarIdioma("unknown")).toBe("pt-BR");
    expect(normalizarIdioma("es")).toBe("es");
    expect(traduzir("Entrar", "pt-BR")).toBe("Entrar");
    expect(traduzir("Entrar", "es")).toBe("Entrar");
    expect(parseAcceptLanguage("pt-BR,es;q=0.5")).toBe("pt-BR");
    expect(parseAcceptLanguage("es-MX,pt;q=0.5")).toBe("es");
  });
  it.each(["", "c67e9f8a-0000-4000-8000-000000000000", "df10c6c2-0000-4000-8000-000000000000"])("rejects missing/wrong exact demo channel: %s", (channel) => {
    demo(); vi.stubEnv("DEMO_WEB_CHANNEL_ID", channel);
    expect(() => idiomaDaDemoWeb()).toThrow("demo_web_ingress_denied");
  });
  it("rejects ambiguous worker/web mode instead of selecting English", () => {
    demo(); vi.stubEnv("DEMO_INBOUND_ONLY", "true");
    expect(() => idiomaDaDemoWeb()).toThrow("demo_web_ingress_denied");
  });
  it("keeps English out of legacy normalization and serves explicit demo dates/label", () => {
    expect(normalizarIdioma("en-US")).toBe("pt-BR");
    expect(parseAcceptLanguage("en-GB")).toBeNull();
    expect(localeDeData("en-US").code).toBe("en-US");
    expect(localeDeData("pt-BR").code).toBe("pt-BR");
    expect(IDIOMAS_VISIVEIS.map(i => i.codigo)).toEqual(["pt-BR", "es"]);
    expect(idiomaVisivelPorCodigo("en-US").rotuloCurto).toBe("EN");
  });
  it("plain locale input and client selection cannot authorize demo presentation", () => {
    render(<IdiomaProvider locale="en-US"><Label /><ChooseEnglish /></IdiomaProvider>);
    expect(screen.getByText("Entrar")).toBeTruthy();
    fireEvent.click(screen.getByText("client locale request"));
    expect(screen.queryByText("Sign in")).toBeNull();
    expect(document.documentElement.lang).toBe("pt-BR");
    expect(demoWebPresentation()).toBeNull();
  });
  it("clears the explicit presentation when the server removes it", async () => {
    demo();
    const view = render(<IdiomaProvider locale="pt-BR" demoPresentation={demoWebPresentation()}><Label /></IdiomaProvider>);
    expect(screen.getByText("Sign in")).toBeTruthy();
    view.rerender(<IdiomaProvider locale="pt-BR"><Label /></IdiomaProvider>);
    await waitFor(() => expect(screen.getByText("Entrar")).toBeTruthy());
  });
  it("rejects a foreign presentation channel", () => {
    const invalid = { channelId: "foreign", locale: "en-US" } as unknown as NonNullable<ReturnType<typeof demoWebPresentation>>;
    expect(() => render(<IdiomaProvider locale="pt-BR" demoPresentation={invalid}><Label /></IdiomaProvider>)).toThrow("invalid_demo_web_presentation");
  });
  it.each([
    ["en-US,en;q=0.9,fr;q=0.8", null],
    ["en;q=0.9,es;q=0.8", "es"],
    ["en-US,pt-BR;q=0.8", "pt-BR"],
  ])("retains legacy browser negotiation: %s", (header, expected) => {
    expect(parseAcceptLanguage(header)).toBe(expected);
  });
  it.each(["en-US", "unknown", null, undefined])("retains shared Worker normalization: %s", locale => {
    demo(); // Even a demo Web environment cannot change the shared Worker helper.
    expect(normalizarIdioma(locale)).toBe("pt-BR");
  });
  it("reuses the full catalog including Login, Sidebar and Inbox labels", () => {
    const catalog = catalogo as Record<string, string>;
    expect(Object.keys(DICIONARIO).filter(key => !catalog[key])).toEqual([]);
    for (const label of [...NAV_DESTINATIONS.filter(d => d.sidebar).map(d => d.label), ...NAV_GROUPS.map(g => g.label)]) {
      expect(catalog[label], label).toBeTruthy();
      expect(traduzir(label, "en-US")).toBe(catalog[label]);
    }
    expect(traduzir("Entrar", "en-US")).toBe("Sign in");
  });
});

const correctedCopy: Record<string, string> = {
  "Não foi possível resolver todos os avisos. Confira a lista e tente novamente.": "Unable to resolve all notices. Check the list and try again.",
  "Falha ao aprovar a solicitação. Tente novamente.": "Failed to approve the request. Try again.",
  "Falha ao criar agente:": "Failed to create agent:",
  "Não foi possível carregar suas agendas.": "Unable to load your calendars.",
  "Falha ao confirmar. Tente novamente.": "Failed to confirm. Try again.",
  "Não foi possível registrar a decisão.": "Unable to record the decision.",
  "Não foi possível confirmar o cancelamento. Verifique o recibo antes de repetir a ação.": "Unable to confirm the cancellation. Check the receipt before repeating the action.",
  "Não foi possível conferir as orientações instaladas": "Unable to check the installed instructions",
  "Não foi possível consultar esta conexão. Tente novamente.": "Unable to check this connection. Try again.",
  "Erro ao buscar agent.": "Error fetching agent.",
  "Falha ao atualizar o aviso.": "Failed to update the notice.",
  "Falha ao carregar as propostas.": "Failed to load the proposals.",
  "Falha ao decifrar credential.": "Failed to decrypt credential.",
  "Falha ao processar o envio do arquivo.": "Failed to process the file upload.",
  "Não é possível revogar o último admin do tenant.": "Cannot revoke the last tenant administrator."
};
it.each(Object.entries(correctedCopy))("corrects the source meaning without invented interpolation: %s", (key, value) => {
  expect(traduzir(key, "en-US")).toBe(value);
  expect(value.includes("%s")).toBe(key.includes("%s"));
});
it("contains no unrelated temporary-folder errors", () => {
  expect(Object.values(catalogo).filter(value => value.includes("Could not close temporary folder"))).toEqual([]);
});

it("does not load English for legacy translations and caches explicit English loading", () => {
  const source = readFileSync("lib/i18n/dicionario.ts", "utf8");
  const requireCatalog = vi.fn((name: string) => {
    expect(name).toBe("./traducoes/en-US.json");
    return { Entrar: "Sign in" };
  });
  const api = {} as { traduzir: typeof traduzir };
  runInNewContext(transpileModule(source, {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
  }).outputText, { exports: api, require: requireCatalog });
  expect(api.traduzir("Entrar", "pt-BR")).toBe("Entrar");
  expect(api.traduzir("Contatos", "es")).toBe("Contactos");
  expect(requireCatalog).not.toHaveBeenCalled();
  expect(api.traduzir("Entrar", "en-US")).toBe("Sign in");
  expect(api.traduzir("Entrar", "en-US")).toBe("Sign in");
  expect(requireCatalog).toHaveBeenCalledTimes(1);
});
