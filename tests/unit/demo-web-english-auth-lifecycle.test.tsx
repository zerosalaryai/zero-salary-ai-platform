// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AuthUser, ActiveOrg } from "@/lib/auth/types";
import { AuthProvider, useAuth } from "@/hooks/auth/AuthProvider";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";
import { DEMO_WEB_CHANNEL } from "@/lib/channels/demo-web-ingress";
const f = vi.hoisted(() => ({ refresh: vi.fn(), logout: vi.fn(), reset: vi.fn(), demo: vi.fn() }));
vi.mock("@/lib/auth/demo-web-login", () => ({ demoWebLogin: f.demo }));
vi.mock("@/lib/supabase/browser", () => ({ createClient: () => ({ auth: { refreshSession: f.refresh } }), resetRealtimeAuthentication: f.reset }));
vi.mock("@/app/actions/auth/signOut", () => ({ signOut: f.logout }));
vi.mock("@/app/providers", () => ({ Providers: ({ children }: { children: React.ReactNode }) => children }));
const user = { id: "synthetic-user", support: null } as unknown as AuthUser;
const org = { orgId: "synthetic-org" } as ActiveOrg;
function Session() { const auth = useAuth(); return <button onClick={() => { void auth.signOut(); }}>Sign out {auth.user.id}</button>; }
function mount(demo: boolean, support = false) {
  return render(<IdiomaProvider locale="pt-BR" demoPresentation={demo ? { channelId: DEMO_WEB_CHANNEL, locale: "en-US" } : null}>
    <AuthProvider user={support ? { ...user, support: { id: "support", access_mode: "support_readonly", status: "active" } } as AuthUser : user} activeOrg={org}><Session /></AuthProvider>
  </IdiomaProvider>);
}
beforeEach(() => { vi.clearAllMocks(); vi.useFakeTimers(); f.refresh.mockResolvedValue({}); f.demo.mockResolvedValue({ refreshed: true }); });
afterEach(() => { cleanup(); vi.useRealTimers(); });
it.each([false, true])("retains required auth refresh and logout behavior (demo=%s)", async demo => {
  const v = mount(demo);
  expect(screen.getByText("Sign out synthetic-user")).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(40 * 60 * 1000); });
  if (demo) expect(f.demo).toHaveBeenCalledWith({ kind: "refresh" });
  else expect(f.refresh).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button"));
  await act(async () => {});
  if (demo) { expect(f.demo).toHaveBeenCalledWith({ kind: "logout" }); expect(f.refresh).not.toHaveBeenCalled(); expect(f.logout).not.toHaveBeenCalled(); }
  else expect(f.logout).toHaveBeenCalledTimes(1);
  v.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(40 * 60 * 1000); });
  if (demo) expect(f.demo).toHaveBeenCalledWith({ kind: "refresh" });
  else expect(f.refresh).toHaveBeenCalledTimes(1);
});
it("fails closed for support sessions without mounting unsupported polling or viewer", async () => {
  const fetchMock = vi.mocked(fetch); fetchMock.mockClear();
  mount(true, true);
  expect(screen.getByRole("alert").textContent).toContain("normal authenticated account");
  expect(screen.queryByRole("button")).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(fetchMock).not.toHaveBeenCalled();
});

it("shows logout failure without claiming success or calling a Server Action", async () => {
  f.demo.mockRejectedValue(new Error("denied")); mount(true);
  fireEvent.click(screen.getByRole("button"));
  await act(async () => {});
  expect(screen.getByRole("alert").textContent).toContain("Unable to sign out");
  expect(f.logout).not.toHaveBeenCalled();
});
it("does not overlap demo refresh calls and cleans up its timer", async () => {
  let finish!: (v: unknown) => void;
  f.demo.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const view = mount(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(80 * 60 * 1000); });
  expect(f.demo).toHaveBeenCalledTimes(1); expect(f.refresh).not.toHaveBeenCalled();
  view.unmount(); finish({refreshed:true});
  await act(async () => { await vi.advanceTimersByTimeAsync(40 * 60 * 1000); });
  expect(f.demo).toHaveBeenCalledTimes(1);
});
