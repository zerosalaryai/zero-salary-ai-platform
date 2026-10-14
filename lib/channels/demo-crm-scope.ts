import { demoCrmOriginAllowed } from "./demo-crm-origin";
import "server-only";
import { z } from "zod";
import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";
import { fail } from "@/lib/api/wrappers";
import { DEMO_WEB_CHANNEL, readDemoWebConfig } from "./demo-web-ingress";
import { demoCrmRecovery } from "./demo-crm-recovery";
import { demoInboxReadChannel } from "./demo-inbox-read";

/** Domain boundary for original CRM handlers. Existing RBAC/MFA still runs afterward. */
export async function guardDemoCrmRequest(req?: Request): Promise<Response | null> {
  if (!readDemoWebConfig()) return null;
  const denied = () => fail("forbidden", "demo_crm_scope_denied", 403);
  try {
    if (!req) return denied();
    if (!demoCrmRecovery()) {
      if (req.method === "GET" && /^\/api\/v1\/conversations\/[0-9a-f-]{36}$/i.test(new URL(req.url).pathname)) return null;
      return denied();
    }
    if (req.method !== "GET" && !demoCrmOriginAllowed(req)) return denied();
    const auth = await requireRole("viewer", {});
    if (!auth.ok || auth.user.support) return denied();
    const db = await createClient();
    await demoInboxReadChannel(db, {organization_id: auth.org.orgId, actor: {type: "user", id: auth.user.id}, requestId: crypto.randomUUID()});
    const pathname = new URL(req.url).pathname;
    if (["/api/v1/team/assignable", "/api/v1/pipelines", "/api/v1/pipelines/default"].includes(pathname)) return req.method === "GET" ? null : denied();
    const match = pathname.match(/^\/api\/v1\/(conversations|contacts|leads)\/([^/]+)/);
    if (!match || !z.uuid().safeParse(match[2]).success) return denied();
    const [ , table, id ] = match;
    let contactId: string | undefined;
    if (table === "conversations") {
      const r = await db.from("conversations").select("id,contact_id").eq("id", id!)
        .eq("organization_id", auth.org.orgId).eq("channel_session_id", DEMO_WEB_CHANNEL).maybeSingle();
      if (r.error || !r.data) return denied();
      contactId = r.data.contact_id;
    } else if (table === "leads") {
      const r = await db.from("crm_leads").select("id,contact_id").eq("id", id!).eq("organization_id", auth.org.orgId).maybeSingle();
      if (r.error || !r.data) return denied();
      contactId = r.data.contact_id ?? undefined;
    } else contactId = id;
    if (!contactId) return denied();
    const bound = await db.rpc("fn_demo_crm_scope" as never, {
      p_org: auth.org.orgId, p_conversation: table === "conversations" ? id : null,
      p_contact: table === "contacts" ? id : null, p_lead: table === "leads" ? id : null,
    } as never);
    if (bound.error || bound.data !== true) return denied();
    // A shared contact's summary/status cannot be attributed to 0230 safely.
    const [contact, conversations] = await Promise.all([
      db.from("contacts").select("id").eq("id", contactId).eq("organization_id", auth.org.orgId).maybeSingle(),
      db.from("conversations").select("channel_session_id").eq("contact_id", contactId).eq("organization_id", auth.org.orgId),
    ]);
    if (contact.error || !contact.data || conversations.error || !conversations.data?.length ||
        conversations.data.some(c => c.channel_session_id !== DEMO_WEB_CHANNEL)) return denied();
    if (req.method !== "GET") {
      // Resource identity is immutable through the recovery HTTP surface.
      const body = await req.clone().json().catch(() => null);
      if (body && ["organization_id", "channel_session_id", "contact_id", "conversation_id"].some(k => k in body)) return denied();
    }
    return null;
  } catch { return denied(); }
}
