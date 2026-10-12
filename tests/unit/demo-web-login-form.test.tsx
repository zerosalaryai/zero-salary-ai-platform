// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LoginForm } from "@/components/auth/LoginForm";

const mocks = vi.hoisted(() => ({ login: vi.fn(), replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace }) }));
vi.mock("@/app/actions/auth/signInWithPassword", () => ({ signInWithPassword: mocks.login }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (text: string) => text }));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.login.mockReset();
  mocks.replace.mockReset();
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function submit() {
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "unit@example.invalid" } });
  fireEvent.change(screen.getByLabelText("Senha"), { target: { value: "unit-password" } });
  fireEvent.submit(screen.getByRole("button", { name: "Entrar" }).closest("form")!);
}

it.each(["403", "network"])("demo login failure stays inline without exposing details: %s", async (failure) => {
  const fetch = vi.spyOn(globalThis, "fetch");
  if (failure === "403") fetch.mockResolvedValue(new Response("forbidden", { status: 403 }));
  else fetch.mockRejectedValue(new Error("private failure detail"));
  render(<LoginForm demoWeb next="/app/inbox" />);
  submit();
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Erro inesperado. Tente novamente."));
  expect(fetch).toHaveBeenCalledWith("/api/demo-web-auth", expect.objectContaining({
    method: "POST", headers: { "content-type": "application/json" },
  }));
  expect(mocks.login).not.toHaveBeenCalled();
  expect(mocks.replace).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Entrar" }).hasAttribute("disabled")).toBe(false);
});

it("demo authentication result still displays invalid credentials inline", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
    data: { ok: false, error: "invalid_credentials" },
  }), { status: 200 }));
  render(<LoginForm demoWeb />);
  submit();
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Email ou senha incorretos."));
  expect(mocks.login).not.toHaveBeenCalled();
});

it("normal login still uses its existing Server Action", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  mocks.login.mockResolvedValue({ ok: false, error: "invalid_credentials" });
  render(<LoginForm />);
  submit();
  await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("Email ou senha incorretos."));
  expect(mocks.login).toHaveBeenCalledOnce();
  expect(fetch).not.toHaveBeenCalled();
});
