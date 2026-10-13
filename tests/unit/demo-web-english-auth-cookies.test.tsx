import { beforeEach, expect, it, vi } from "vitest";
const f = vi.hoisted(() => ({ set: vi.fn(), getAll: vi.fn(), sdk: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: async () => ({ getAll: f.getAll, set: f.set }) }));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.invalid", NEXT_PUBLIC_SUPABASE_ANON_KEY: "synthetic-anon", NEXT_PUBLIC_APP_URL: "https://demo.invalid" } }));
vi.mock("@supabase/ssr", () => ({ createServerClient: f.sdk }));
import { createClient, createCookieBufferedClient } from "@/lib/supabase/server";
beforeEach(() => { vi.clearAllMocks(); });
it("retains canonical HttpOnly, Secure, Strict cookie contract and SDK writes", async () => {
 f.sdk.mockReturnValue({ auth: {} }); await createClient();
 const options = f.sdk.mock.calls[0]![2];
 expect(options.cookieOptions).toEqual({ name: "sb-deskcomm-auth", sameSite: "strict", httpOnly: true, secure: true, path: "/" });
 f.getAll.mockReturnValue([{ name: "synthetic-cookie", value: "synthetic-value" }]);
 expect(options.cookies.getAll()).toEqual(f.getAll.mock.results[0]?.value);
 options.cookies.setAll([{ name: "synthetic-cookie", value: "synthetic-rotated", options: options.cookieOptions }]);
 expect(f.set).toHaveBeenCalledWith("synthetic-cookie", "synthetic-rotated", expect.objectContaining({ httpOnly: true, sameSite: "strict", secure: true }));
});

it("buffers SDK logout/error cookie removal until explicit successful commit", async () => {
 f.getAll.mockReturnValue([{name:"synthetic-cookie",value:"original"}]);
 f.sdk.mockReturnValue({auth:{}});
 const buffered = await createCookieBufferedClient();
 const options = f.sdk.mock.calls[0]![2];
 expect(options.cookieOptions).toEqual({name:"sb-deskcomm-auth",sameSite:"strict",httpOnly:true,secure:true,path:"/"});
 options.cookies.setAll([{name:"synthetic-cookie",value:"",options:{...options.cookieOptions,maxAge:0}}]);
 expect(f.set).not.toHaveBeenCalled();
 expect(options.cookies.getAll()).toEqual([expect.objectContaining({name:"synthetic-cookie",value:""})]);
 buffered.commitCookies();
 expect(f.set).toHaveBeenCalledWith("synthetic-cookie","",expect.objectContaining({maxAge:0,httpOnly:true,sameSite:"strict",secure:true}));
});
