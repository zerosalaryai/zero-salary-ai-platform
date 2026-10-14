import type pg from "pg";
import type { DemoBinding } from "@/lib/channels/demo-inbound-only";
import { demoCrmRecovery } from "@/lib/channels/demo-crm-recovery";
import { withDemoStaffDelivery, type StaffDelivery } from "@/lib/channels/demo-staff-delivery";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import type { Logger } from "@/lib/agent-engine/obs/logger";

/** One dedicated worker authority for both AI and explicit staff replies. */
export async function demoStaffTick(pool: pg.Pool, binding: DemoBinding): Promise<void> {
  if (!demoCrmRecovery()) return;
  const { rows } = await pool.query<StaffDelivery>("select * from public.fn_demo_claim_staff_reply($1,$2)", [binding.organizationId, binding.startedAt]);
  const row = rows[0];
  if (!row) return;
  let status = "uncertain";
  try {
    const message = await withDemoStaffDelivery(pool, binding, row, () => sendMessageHandler(createAdminClient(), {
      organization_id: binding.organizationId, actor: { type: "user", id: row.actor_id },
      requestId: row.id, internalMessageId: row.message_id,
    }, { conversation_id: row.conversation_id, type: "text", body: row.body }));
    status = ["sent", "delivered", "read"].includes(message.status) && message.external_id ? "sent" : "failed";
  } finally {
    // A lost response remains uncertain; never re-claim or re-send this intent.
    await pool.query("select public.fn_demo_settle_staff_reply($1,$2,$3)", [binding.organizationId, row.id, status]);
  }
}
export async function runDemoStaffLoop(pool: pg.Pool, binding: DemoBinding, log: Logger, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try { await demoStaffTick(pool, binding); } catch { log.error("demo staff delivery requires reconciliation", {}); }
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
      const timer = setTimeout(done, 5000); signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
  }
}
