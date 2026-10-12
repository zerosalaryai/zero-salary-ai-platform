// Source invariants only. These checks do not substitute for executing PostgreSQL.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
const file = "supabase/migrations/20261010180000_0342_demo_inbound_receipts.sql";
const sql = readFileSync(file, "utf8");
it("ships the identical additive migration in baseline and manifest", () => {
  expect(readFileSync("supabase/baseline.sql", "utf8").endsWith(sql)).toBe(true);
  expect(readFileSync("supabase/migrations/MANIFEST.md", "utf8")).toContain(
    "0342_demo_inbound_receipts",
  );
});
it("reserves and locks one receipt before creating message and dispatch", () => {
  const rpc = sql.slice(sql.indexOf("create or replace function public.fn_demo_ingest_meta("));
  expect(
    rpc.indexOf("on conflict(organization_id,channel_session_id,meta_message_id) do nothing"),
  ).toBeLessThan(rpc.indexOf("for update;"));
  expect(rpc.indexOf("for update;")).toBeLessThan(rpc.indexOf("insert into public.messages"));
  expect(rpc.match(/event:=public.emit_event/g)).toHaveLength(1);
  expect(rpc).not.toMatch(/exception when|commit;|rollback;/i);
  expect(rpc.indexOf("return jsonb_build_object('duplicate',true")).toBeLessThan(
    rpc.indexOf("insert into public.messages"),
  );
});
it("uses the canonical service lock order and timestamp function once", () => {
  const rpc = sql.slice(sql.indexOf("create or replace function public.fn_demo_ingest_meta("));
  expect(rpc.indexOf("perform public.fn_service_lock")).toBeLessThan(
    rpc.indexOf("for no key update"),
  );
  expect(rpc.indexOf("from public.conversations where organization_id")).toBeLessThan(
    rpc.indexOf("select * into strict c from public.contacts"),
  );
  expect(rpc.match(/perform public.fn_mark_conversation_message/g)).toHaveLength(1);
});
it.each(["trg_messages_emit_event", "trg_demanda_abre_no_inbound", "trg_appointment_inbound"])(
  "contains %s only with a trusted receipt predicate",
  (name) => {
    expect(sql).toMatch(
      new RegExp(
        `create trigger ${name}[\\s\\S]*?when \\(not public.fn_demo_receipt_message_bound`,
      ),
    );
  },
);
it("contains initial routing and unmarked duplicate dispatch attempts", () => {
  expect(sql).toContain(
    "if public.fn_demo_receipt_conversation_bound(new.organization_id,new.channel_session_id,new.contact_id)",
  );
  expect(sql).toContain("trg_demo_receipt_dispatch_guard before insert on public.event_log");
  expect(sql).toContain("r.outcome<>'pending' or r.owner_txid<>txid_current()");
});
it("restricts table writes and RPC to the trusted server", () => {
  expect(sql).toContain("revoke all on public.demo_inbound_receipts from service_role");
  expect(sql).toContain("grant select on public.demo_inbound_receipts to service_role");
  expect(sql).toContain(
    "fn_demo_ingest_meta(text,uuid,uuid,text,text,timestamptz,text,text,boolean) from public,anon,authenticated",
  );
  expect(sql).toContain("set search_path=pg_catalog");
  expect(sql).toContain(
    "or p_channel is distinct from 'c67e9f8a-8719-4481-9154-ed8a464f85bd'::uuid",
  );
});
it("rejects legacy adoption and preserves admission/provider timestamps", () => {
  expect(sql).toContain(
    "or exists(select 1 from public.messages where organization_id=p_org and external_id=e->>'external_id')",
  );
  expect(sql).toContain("sent<p_admitted_at-interval '5 minutes'");
  expect(sql).not.toMatch(/update public\.messages set.*sent_at/i);
});

it("proves new-contact ownership with insert RETURNING and never conflict adoption", () => {
  const rpc = sql.slice(sql.indexOf("create or replace function public.fn_demo_ingest_meta("));
  expect(rpc).toContain("on conflict do nothing returning id into contact");
  expect(rpc).toContain(
    "if contact is null or not exists(select 1 from public.contacts where id=contact",
  );
  expect(rpc).not.toContain("contact:=public.fn_upsert_wa_contact");
  expect(rpc).not.toContain("xmin::text::bigint=mod(txid_current()");
});
