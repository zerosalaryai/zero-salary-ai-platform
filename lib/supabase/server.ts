/**
 * Supabase client para Server Components, Route Handlers e Server Actions.
 *
 * Lê/escreve cookies via next/headers. Sempre use `getUser()` (valida JWT no
 * backend), NUNCA `getSession()` (confia no cookie local sem revalidar).
 */

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { cookieSecure } from "@/lib/supabase/cookie-secure";
import { cookies } from "next/headers";
import { env } from "@/lib/env";

export async function createClient() {
  const cookieStore = await cookies();

  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => {
            cookieStore.set(name, value, options);
          });
        } catch {
          // setAll pode ser chamado de Server Component; nesse caso, ignoramos.
          // Refresh de sessão acontece no middleware do Next.
        }
      },
    },
    // D-01.01: cookie name canônico alinhado ao middleware.
    cookieOptions: {
      name: "sb-deskcomm-auth",
      sameSite: "strict",
      httpOnly: true,
      secure: cookieSecure(),
      path: "/",
    },
  });
}

/** Demo logout: SDK signOut can clear storage even on a failed HTTP revocation.
 * Stage its cookie writes until the caller has checked success. Never expose tokens.
 * Normal clients above retain their existing behavior.
 */
export async function createCookieBufferedClient() {
  const store = await cookies();
  const pending = new Map<string, { name: string; value: string; options: CookieOptions }>();
  const supabase = createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        const values = new Map(store.getAll().map(cookie => [cookie.name, cookie]));
        for (const cookie of pending.values()) values.set(cookie.name, cookie);
        return [...values.values()];
      },
      setAll(writes: { name: string; value: string; options: CookieOptions }[]) {
        for (const cookie of writes) pending.set(cookie.name, cookie);
      },
    },
    cookieOptions: {
      name: "sb-deskcomm-auth", sameSite: "strict", httpOnly: true,
      secure: cookieSecure(), path: "/",
    },
  });
  return {
    supabase,
    commitCookies() {
      for (const { name, value, options } of pending.values()) store.set(name, value, options);
      pending.clear();
    },
  };
}
