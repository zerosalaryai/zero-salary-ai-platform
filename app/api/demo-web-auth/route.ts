import { z } from "zod";
import { type NextRequest } from "next/server";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { getURLFromRedirectError } from "next/dist/client/components/redirect";
import { readDemoWebConfig } from "@/lib/channels/demo-web-ingress";
import { signInWithPassword } from "@/app/actions/auth/signInWithPassword";
import { verifyMfa } from "@/app/actions/auth/verifyMfa";
import { loginSchema } from "@/lib/auth/schemas";
import { createClient, createCookieBufferedClient } from "@/lib/supabase/server";
import { requireRole } from "@/lib/auth/require-role";
import { DEMO_WEB_CHANNEL } from "@/lib/channels/demo-web-ingress";
import { cookies } from "next/headers";
import { audit } from "@/lib/audit";
import { enrollMfa } from "@/app/actions/auth/enrollMfa";
import { confirmMfaEnroll } from "@/app/actions/auth/confirmMfaEnroll";
import { safeNext } from "@/lib/auth/safe-next";
import { ok, fail } from "@/lib/api/wrappers";

const input = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("refresh") }).strict(),
  z.object({ kind: z.literal("logout") }).strict(),
  z.object({ kind: z.literal("enroll") }).strict(),
  z.object({ kind: z.literal("confirm-enroll"), code: z.string().regex(/^\d{6}$/), factor_id: z.uuid() }).strict(),
  z
    .object({ kind: z.literal("login"), credentials: loginSchema, next: z.string().optional() })
    .strict(),
  z
    .object({
      kind: z.literal("totp"),
      code: z.string().regex(/^\d{6}$/),
      next: z.string().optional(),
    })
    .strict(),
]);
/** Explicit public origin: never infer trust from proxy-controlled request headers. */
function demoPublicOrigin(source: NodeJS.ProcessEnv = process.env): string | null {
  const raw = source.NEXT_PUBLIC_APP_URL;
  if (!raw || raw !== raw.trim()) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || url.username || url.password ||
        url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}
/** Porta de autenticação explícita. Não aceita Server Actions nem outras mutações. */
export async function POST(req: NextRequest): Promise<Response> {
  const response = await handlePost(req);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
async function handlePost(req: NextRequest): Promise<Response> {
  if (!readDemoWebConfig()) return fail("not_found", "not found", 404);
  const publicOrigin = demoPublicOrigin();
  if (
    !publicOrigin ||
    req.headers.has("next-action") ||
    req.headers.get("origin") !== publicOrigin ||
    req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json"
  )
    return fail("forbidden", "forbidden", 403);
  const parsed = input.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", "invalid authentication input", 400);
  try {
    const v = parsed.data;
    if (v.kind === "logout") {
      const { supabase, commitCookies } = await createCookieBufferedClient();
      const { data: { user }, error } = await supabase.auth.getUser();
      if (error || !user) return fail("unauthenticated", "Authentication required", 401);
      // Only this browser session; never revoke other devices or tenants' sessions.
      const { error: logoutError } = await supabase.auth.signOut({ scope: "local" });
      if (logoutError) return fail("internal_error", "Logout unavailable", 503);
      commitCookies();
      (await cookies()).delete("active_org");
      await audit({ action: "auth.logout", actorUserId: user.id,
        requestId: req.headers.get("x-request-id") });
      return ok({ redirect: "/login" });
    }
    if (v.kind === "refresh" || v.kind === "enroll" || v.kind === "confirm-enroll") {
      // Canonical guard preserves membership revocation and MFA session enforcement.
      const authz = await requireRole("viewer");
      if (!authz.ok) return authz.response;
      if (authz.user.support) return fail("forbidden", "forbidden", 403);
      const supabase = await createClient();
      const { data: channel, error } = await supabase.from("channel_sessions")
        .select("id, organization_id")
        .eq("id", DEMO_WEB_CHANNEL).eq("organization_id", authz.org.orgId)
        .is("archived_at", null).maybeSingle();
      if (error || !channel || channel.id !== DEMO_WEB_CHANNEL ||
          channel.organization_id !== authz.org.orgId)
        return fail("forbidden", "forbidden", 403);
      if (v.kind === "enroll") return ok(await enrollMfa());
      if (v.kind === "confirm-enroll") {
        const { data, error: factorError } = await supabase.auth.mfa.listFactors();
        if (factorError || !data?.all.some(f => f.id === v.factor_id && f.factor_type === "totp" && f.status === "unverified"))
          return fail("forbidden", "forbidden", 403);
        return ok(await confirmMfaEnroll(v.code, v.factor_id));
      }
      // No refresh token is accepted in JSON or returned to browser JavaScript.
      // The canonical SSR client rotates and writes HttpOnly/Strict cookies.
      const { supabase: refreshClient, commitCookies } = await createCookieBufferedClient();
      const { data, error: refreshError } = await refreshClient.auth.refreshSession();
      if (refreshError || !data.session) return fail("unauthenticated", "Session expired", 401);
      const { data: verified, error: verifyError } = await refreshClient.auth.getUser();
      if (verifyError || verified.user?.id !== authz.user.id)
        return fail("unauthenticated", "Session expired", 401);
      commitCookies();
      return ok({ refreshed: true });
    }
    const result =
      v.kind === "login"
        ? await signInWithPassword(v.credentials, v.next)
        : await verifyMfa(v.code, v.next);
    return ok(result);
  } catch (error) {
    if (!isRedirectError(error)) {
      if (parsed.data.kind !== "login" && parsed.data.kind !== "totp")
        return fail("internal_error", "Authentication unavailable", 503);
      throw error;
    }
    return ok({ redirect: safeNext(getURLFromRedirectError(error) ?? undefined, "/app") });
  }
}
