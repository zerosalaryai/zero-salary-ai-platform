// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { DEMO_WEB_CHANNEL } from "@/lib/channels/demo-web-ingress";
import { ApiError } from "@/lib/api/types";
import { InboxLayout } from "@/components/inbox/InboxLayout";
import { SeletorDeIdioma } from "@/components/shell/SeletorDeIdioma";
import { AppShell } from "@/app/app/_components/AppShell";
import { InterfaceRefresh } from "@/hooks/auth/InterfaceRefresh";
import { VoiceCallProvider } from "@/components/voice/VoiceCallContext";
import { AlertsBell } from "@/components/shell/AlertsBell";
import { useRealtimeChannel } from "@/hooks/realtime/useRealtimeChannel";
import { readFileSync } from "node:fs";
const f = vi.hoisted(() => ({ get: vi.fn(), action: vi.fn(), presence: vi.fn(), alerts: vi.fn(), voice: vi.fn(), client: vi.fn(), refresh: vi.fn(), org: "10000000-0000-4000-8000-000000000001" }));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: f.get } }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useAuth: () => ({ user: { id: "viewer", support: null }, activeOrg: { orgId: f.org } }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: f.refresh }), usePathname: () => "/app/inbox", useSearchParams: () => new URLSearchParams() }));
vi.mock("@/app/actions/settings/trocarIdioma", () => ({ trocarIdioma: f.action }));
vi.mock("@/lib/supabase/browser", () => ({ createClient: f.client, prepareRealtimeAuthentication: vi.fn() }));
vi.mock("@/hooks/voice/useVoiceCallSession", () => ({ useVoiceCallSession: f.voice }));
vi.mock("@/components/voice/IncomingCallBanner", () => ({ IncomingCallBanner: () => null }));
vi.mock("@/components/voice/ActiveCallPanel", () => ({ ActiveCallPanel: () => null }));
vi.mock("@/hooks/notifications/useInboundMessageAlerts", () => ({ useInboundMessageAlerts: f.alerts }));
vi.mock("@/hooks/notifications/useCrmAlerts", () => ({ useCrmAlerts: f.alerts }));
vi.mock("@/hooks/atendimento/useSinalDePresenca", () => ({ useSinalDePresenca: f.presence }));
vi.mock("@/lib/notifications/notify_open", () => ({ useNotifyOpenFromServiceWorker: vi.fn() }));
vi.mock("@/components/shell/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("@/components/shell/TopBar", () => ({ TopBar: () => null }));
vi.mock("@/components/shell/UserMenu", () => ({ UserMenu: () => <SeletorDeIdioma /> }));
vi.mock("@/components/shell/BarraDeProgressoNavegacao", () => ({ BarraDeProgressoNavegacao: () => null }));
vi.mock("@/hooks/ai/useAgentInbox", () => ({ useAgentInbox: f.alerts }));
vi.mock("@/hooks/ai/useAutomaticoAtivo", () => ({ useAutomaticoAtivo: f.alerts }));
vi.mock("@/hooks/inbox/useConversationsRealtime", () => ({ useConversationsRealtime: f.alerts }));
vi.mock("@/hooks/inbox/useConversation", () => ({ useConversation: f.alerts, isNotFound: () => false }));
vi.mock("@/hooks/inbox/useClaimConversation", () => ({ useClaimConversation: f.alerts }));
vi.mock("@/hooks/inbox/useCloseConversation", () => ({ useCloseConversation: f.alerts }));
vi.mock("@/hooks/inbox/useMarkAsRead", () => ({ useMarkAsRead: f.alerts }));
vi.mock("@/components/inbox/JanelaFechadaAviso", () => ({ JanelaFechadaAviso: () => null }));
vi.mock("@/components/inbox/ChatThread", () => ({ ChatThread: () => { throw Error("Operational thread mounted"); } }));
vi.mock("@/components/inbox/Composer", () => ({ Composer: () => { throw Error("Composer mounted"); } }));
vi.mock("@/components/inbox/ConversationList", () => ({ ConversationList: () => null }));
vi.mock("@/components/inbox/InboxFilters", () => ({ InboxFilters: () => null }));
vi.mock("@/components/inbox/ConversationHeader", () => ({ ConversationHeader: () => null }));
vi.mock("@/components/inbox/RetentionNotice", () => ({ RetentionNotice: () => null }));
vi.mock("@/components/inbox/CRMSidePanel", () => ({ CRMSidePanel: () => null }));
vi.mock("@/components/inbox/InboxKeyboardShortcuts", () => ({ InboxKeyboardShortcuts: () => null }));
vi.mock("@/components/inbox/ShortcutsHelpDialog", () => ({ ShortcutsHelpDialog: () => null }));
const id = "20000000-0000-4000-8000-000000000001", contact = "30000000-0000-4000-8000-000000000001";
const conversation = () => ({ id, contact_id: contact, organization_id: f.org, channel_session_id: DEMO_WEB_CHANNEL, contacts: { name: "Synthetic customer" } });
const message = (n: number, inbound = true) => ({ id: `m${n}`, conversation_id: id, contact_id: contact, organization_id: f.org, channel_session_id: DEMO_WEB_CHANNEL, direction: inbound ? "inbound" : "outbound", sent_via: inbound ? "external_device" : "ai", sent_at: `2026-10-13T10:00:0${n}Z`, body: inbound ? "Customer text" : "Stored Worker reply", status: "sent", type: "text" });
function mount(children: React.ReactNode, demo = true) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<IdiomaProvider locale="pt-BR" demoPresentation={demo ? { channelId: DEMO_WEB_CHANNEL, locale: "en-US" } : null}><QueryClientProvider client={qc}>{children}</QueryClientProvider></IdiomaProvider>);
}
beforeEach(() => {
  vi.clearAllMocks();
  f.get.mockImplementation(async (path: string) => path.includes("/messages") ? { data: [message(2, false), message(1)] } : path.includes(id) ? { data: conversation() } : { data: [conversation()] });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
function ProbeRealtime() { useRealtimeChannel({ name: "test", onChange: vi.fn() }); return null; }
describe("isolated demo viewer", () => {
  it("shows static EN without a dropdown or language action", () => {
    mount(<SeletorDeIdioma />);
    fireEvent.click(screen.getByText("EN"));
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("Português (BR)")).toBeNull();
    expect(f.action).not.toHaveBeenCalled();
  });
  it("retains the ordinary language selector", async () => {
    mount(<SeletorDeIdioma />, false);
    expect(screen.getByRole("button").textContent).toBe("PT");
    fireEvent.pointerDown(screen.getByRole("button"), { button: 0, ctrlKey: false });
    expect(screen.getByRole("menuitem", { name: "Português (BR)" })).toBeTruthy();
    f.action.mockResolvedValue({ ok: false });
    fireEvent.click(screen.getByRole("menuitem", { name: "Español" }));
    await waitFor(() => expect(f.action).toHaveBeenCalledWith("es"));
  });
  it("shows actual stored customer/AI messages chronologically with no operational hooks", async () => {
    mount(<AppShell sidebarCollapsed={false} podeAtender><InboxLayout /></AppShell>);
    fireEvent.click(await screen.findByText("Synthetic customer"));
    await screen.findByText("Stored Worker reply");
    expect(screen.getAllByRole("listitem")[0]?.textContent).toContain("Customer text");
    expect(screen.getAllByRole("listitem")[1]?.textContent).toContain("AI reply");
    expect(f.alerts).not.toHaveBeenCalled(); expect(f.presence).not.toHaveBeenCalled();
    expect(f.get.mock.calls.every(([p]) => /^\/api\/v1\/conversations(?:\?|\/[0-9a-f-]+(?:\/messages\?)?)/.test(p))).toBe(true);
    expect(f.get.mock.calls[0]?.[0]).toContain(`channel_session_id=${DEMO_WEB_CHANNEL}`);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByText("Send")).toBeNull();
  });
  it.each(["channel", "tenant"])("rejects inconsistent %s list data", async kind => {
    f.get.mockResolvedValue({ data: [{ ...conversation(), ...(kind === "channel" ? { channel_session_id: "df10c6c2-0000-4000-8000-000000000001" } : { organization_id: "foreign" }) }] });
    mount(<InboxLayout />);
    expect((await screen.findByRole("alert")).textContent).toContain("Unable to load conversations");
    expect(screen.queryByText("Synthetic customer")).toBeNull();
  });
  it("does not fetch messages after denied detail access", async () => {
    f.get.mockImplementation(async (p: string) => { if (p.includes(id)) throw new ApiError(403, "forbidden", undefined, "synthetic-request"); return { data: [conversation()] }; });
    mount(<InboxLayout initialSelectedId={id} />);
    await screen.findByText("Conversation unavailable or outside your access.");
    expect(f.get.mock.calls.some(([p]) => p.includes("messages"))).toBe(false);
  });
  it("rejects cross-channel message data", async () => {
    f.get.mockImplementation(async (p: string) => p.includes("messages") ? { data: [{ ...message(1), channel_session_id: "other" }] } : p.includes(id) ? { data: conversation() } : { data: [conversation()] });
    mount(<InboxLayout initialSelectedId={id} />);
    await screen.findByText("Unable to load messages. Your session or access may have changed.");
    expect(screen.queryByText("Customer text")).toBeNull();
  });
  it("does not mount voice, realtime, alerts, or interface listeners", () => {
    const listener = vi.spyOn(window, "addEventListener");
    const documentListener = vi.spyOn(document, "addEventListener");
    render(<IdiomaProvider locale="pt-BR" demoPresentation={{ channelId: DEMO_WEB_CHANNEL, locale: "en-US" }}><VoiceCallProvider><span>Viewer</span></VoiceCallProvider><AlertsBell /><InterfaceRefresh userId="viewer" org={null} support={false} /><ProbeRealtime /></IdiomaProvider>);
    expect(f.voice).not.toHaveBeenCalled(); expect(f.client).not.toHaveBeenCalled(); expect(f.alerts).not.toHaveBeenCalled();
    expect(listener.mock.calls.filter(([event]) => ["focus", "online", "visibilitychange"].includes(event))).toHaveLength(0);
    expect(documentListener.mock.calls.filter(([event]) => event === "visibilitychange")).toHaveLength(0);
    listener.mockRestore(); documentListener.mockRestore();
  });
  it("never overlaps a pending poll and aborts its request on unmount", async () => {
    vi.useFakeTimers(); let signal: AbortSignal | undefined;
    f.get.mockImplementation((_p, options) => { signal = options.signal; return new Promise(() => {}); });
    const view = mount(<InboxLayout />);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(f.get).toHaveBeenCalledTimes(1);
    view.unmount(); expect(signal?.aborted).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(f.get).toHaveBeenCalledTimes(1);
  });
  it("polls only scoped reads and displays a newly stored Worker reply", async () => {
    vi.useFakeTimers(); let replied = false;
    f.get.mockImplementation(async (p: string) => p.includes("messages") ? { data: replied ? [message(2, false), message(1)] : [message(1)] } : p.includes(id) ? { data: conversation() } : { data: [conversation()] });
    mount(<InboxLayout initialSelectedId={id} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(screen.queryByText("Stored Worker reply")).toBeNull();
    replied = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000); });
    expect(screen.getByText("Stored Worker reply")).toBeTruthy();
    expect(f.get.mock.calls.every(([p]) => p.startsWith("/api/v1/conversations"))).toBe(true);
  });
  it("stops polling after a 403 without retries or fabricated rows", async () => {
    vi.useFakeTimers();
    f.get.mockRejectedValue(new ApiError(403, "forbidden", undefined, "synthetic-request"));
    mount(<InboxLayout />);
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(f.get).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toContain("Unable to load conversations");
  });
  it("preserves the existing auth refresh/logout code and MFA gate", () => {
    const auth = readFileSync("hooks/auth/AuthProvider.tsx", "utf8");
    expect(auth).toContain("await supabaseRef.current?.auth.refreshSession()");
    expect(auth).toContain("await signOut()");
    expect(auth).toContain("40 * 60 * 1000");
    expect(auth).toContain("if (demo || !user.support) return");
    const layout = readFileSync("app/app/layout.tsx", "utf8");
    expect(layout).toContain("<MfaEnrollGate enrolled={enrolled}>");
  });
  it("shows a real empty state", async () => {
    f.get.mockResolvedValue({ data: [] }); mount(<InboxLayout />);
    await screen.findByText("No conversations yet.");
    expect(screen.queryByText("Stored Worker reply")).toBeNull();
  });
});
