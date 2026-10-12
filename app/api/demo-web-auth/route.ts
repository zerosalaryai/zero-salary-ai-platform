import { z } from "zod";
import { type NextRequest } from "next/server";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { getURLFromRedirectError } from "next/dist/client/components/redirect";
import { readDemoWebConfig } from "@/lib/channels/demo-web-ingress";
import { signInWithPassword } from "@/app/actions/auth/signInWithPassword";
import { verifyMfa } from "@/app/actions/auth/verifyMfa";
import { loginSchema } from "@/lib/auth/schemas";
import { safeNext } from "@/lib/auth/safe-next";
import { ok, fail } from "@/lib/api/wrappers";

const input = z.discriminatedUnion("kind", [
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
    const result =
      v.kind === "login"
        ? await signInWithPassword(v.credentials, v.next)
        : await verifyMfa(v.code, v.next);
    return ok(result);
  } catch (error) {
    if (!isRedirectError(error)) throw error;
    return ok({ redirect: safeNext(getURLFromRedirectError(error) ?? undefined, "/app") });
  }
}
