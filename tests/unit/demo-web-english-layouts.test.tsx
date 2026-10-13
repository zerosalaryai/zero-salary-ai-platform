import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_WEB_CHANNEL } from "@/lib/channels/demo-web-ingress";
import { useT } from "@/lib/i18n/IdiomaProvider";

const state = vi.hoisted(() => ({ locale: "pt-BR", browser: "pt-BR", activeOrg: true }));
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "accept-language": state.browser }),
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({
  auth: { getUser: async () => ({ data: { user: { user_metadata: { locale: state.locale } } } }) },
}) }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => ({ id: "synthetic", idioma: state.locale, support: null, is_platform_admin: false }),
  resolveActiveOrg: async () => state.activeOrg ? ({ orgId: "synthetic", role: "admin" }) : null,
  isMfaEnrolled: async () => false,
  requiresMfa: async () => false,
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { onboarded_at: "2026-01-01", status: "active", settings: null } }) }) }) }),
}) }));
vi.mock("@/lib/branding", () => ({ branding: () => ({ name: "Synthetic Demo" }), marcaEhADoProduto: () => false }));
vi.mock("@/lib/branding/saida", () => ({ marcaDaSaida: async () => ({ nome: "Synthetic Demo", logoUrl: null }) }));
vi.mock("@/lib/branding/instalacao", () => ({ marcaDaInstalacao: async () => ({}) }));
vi.mock("@/lib/branding/organizacao", () => ({ resolverMarcaDaOrganizacao: () => ({ origens: {}, cor: "#000000" }) }));
vi.mock("@/lib/channels/health", () => ({ listarConexoesCaidas: async () => [] }));
vi.mock("@/lib/auth/vinculo-revogado", () => ({ acessoFoiRevogado: async () => false }));
vi.mock("@/components/auth/MfaEnrollGate", () => ({ MfaEnrollGate: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/auth/LoginForm", () => ({ LoginForm: () => <LoginLabel /> }));
vi.mock("@/hooks/auth/InterfaceRefresh", () => ({ InterfaceRefresh: () => null }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ AuthProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/app/app/_components/AppShell", () => ({ AppShell: ({ children }: { children: ReactNode }) => <>{children}<SidebarLabel /></> }));
vi.mock("@/components/voice/VoiceCallContext", () => ({ VoiceCallProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/app/ImpersonateBanner", () => ({ ImpersonateBanner: () => null }));
vi.mock("@/components/app/ConexaoCaidaBanner", () => ({ ConexaoCaidaBanner: () => null }));
vi.mock("@/components/inbox/InboxLayout", () => ({ InboxLayout: () => <InboxLabel /> }));
function LoginLabel() { const t = useT(); return <span>{t("Senha")}</span>; }
function SidebarLabel() { const t = useT(); return <nav>{t("Contatos")}</nav>; }
function InboxLabel() { const t = useT(); return <span>{t("Buscar conversas")}</span>; }

beforeEach(() => {
  state.locale = "pt-BR"; state.browser = "pt-BR"; state.activeOrg = true;
  vi.stubEnv("DEMO_WEB_INGRESS_ONLY", "false"); vi.stubEnv("DEMO_INBOUND_ONLY", "false");
});
afterEach(() => vi.unstubAllEnvs());
function demo() { vi.stubEnv("DEMO_WEB_INGRESS_ONLY", "true"); vi.stubEnv("DEMO_WEB_CHANNEL_ID", DEMO_WEB_CHANNEL); }
async function publicLogin() {
  const { default: Page } = await import("@/app/(public)/login/page");
  const { default: Layout } = await import("@/app/(public)/layout");
  return renderToStaticMarkup(await Layout({ children: await Page({ searchParams: Promise.resolve({}) }) }));
}
async function inbox() {
  const { default: Page } = await import("@/app/app/inbox/page");
  const { default: Layout } = await import("@/app/app/layout");
  return renderToStaticMarkup(await Layout({ children: await Page({ searchParams: Promise.resolve({}) }) }));
}
describe("actual server locale wiring", () => {
  it("renders Login server heading and client provider in English on repeated requests", async () => {
    demo();
    for (let refresh = 0; refresh < 2; refresh++) {
      const html = await publicLogin();
      expect(html).toContain("Sign in"); expect(html).toContain("Password");
      expect(html).not.toContain("Esqueci minha senha");
    }
  });
  it("ignores Portuguese browser detection for anonymous demo login", async () => {
    demo(); state.locale = "";
    expect(await publicLogin()).toContain("Sign in");
  });
  it("renders authenticated Sidebar/Inbox provider in English after refresh", async () => {
    demo();
    for (let refresh = 0; refresh < 2; refresh++) {
      const html = await inbox();
      expect(html).toContain("Contacts"); expect(html).toContain("Search Chats");
    }
  });
  it("also translates the server-rendered Inbox no-organization state", async () => {
    demo(); state.activeOrg = false;
    expect(await inbox()).not.toContain("Você não tem nenhuma organização ativa");
  });
  it.each(["pt-BR", "es"])("preserves ordinary saved locale: %s", async locale => {
    state.locale = locale;
    const html = await publicLogin();
    expect(html).toContain("Entrar");
    expect(html).toContain(locale === "es" ? "Contraseña" : "Senha");
    expect(await inbox()).toContain(locale === "es" ? "Contactos" : "Contatos");
  });
  it("fails closed on invalid demo config", async () => {
    demo(); vi.stubEnv("DEMO_WEB_CHANNEL_ID", "wrong");
    await expect(publicLogin()).rejects.toThrow("demo_web_ingress_denied");
    await expect(inbox()).rejects.toThrow("demo_web_ingress_denied");
  });
});
