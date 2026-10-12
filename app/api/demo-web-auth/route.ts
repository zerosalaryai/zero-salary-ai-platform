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
/** Porta de autenticação explícita. Não aceita Server Actions nem outras mutações. */
export async function POST(req: NextRequest): Promise<Response> {
  if (!readDemoWebConfig()) return fail("not_found", "not found", 404);
  if (
    req.headers.has("next-action") ||
    req.headers.get("origin") !== new URL(req.url).origin ||
    !req.headers.get("content-type")?.startsWith("application/json")
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
