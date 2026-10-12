import type { SupabaseClient } from "@supabase/supabase-js";
import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";
import { requireRole } from "@/lib/auth/require-role";
import { DEMO_WEB_CHANNEL, readDemoWebConfig } from "./demo-web-ingress";

/** Leitura de Inbox: sessão/membership atuais, tenant e canal conferidos no servidor. */
export async function demoInboxReadChannel(
  supabase: SupabaseClient,
  ctx: HandlerCtx,
  requestedChannel?: string,
): Promise<string | undefined> {
  if (!readDemoWebConfig()) return undefined;
  const deny = () =>
    new ApiError(403, "forbidden", undefined, ctx.requestId, "demo_web_ingress_denied");
  if (requestedChannel !== undefined && requestedChannel !== DEMO_WEB_CHANNEL) throw deny();
  const authz = await requireRole("viewer", { requestId: ctx.requestId });
  if (
    !authz.ok ||
    ctx.actor.type !== "user" ||
    ctx.actor.id !== authz.user.id ||
    ctx.organization_id !== authz.org.orgId
  )
    throw deny();
  const { data, error } = await supabase
    .from("channel_sessions")
    .select("id, organization_id")
    .eq("id", DEMO_WEB_CHANNEL)
    .eq("organization_id", authz.org.orgId)
    .is("archived_at", null)
    .maybeSingle();
  if (error || !data || data.id !== DEMO_WEB_CHANNEL || data.organization_id !== authz.org.orgId)
    throw deny();
  return DEMO_WEB_CHANNEL;
}
