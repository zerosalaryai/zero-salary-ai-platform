/** Opt-in ONLY: empty disposable baseline+0342 DB on a private Unix socket.
 * Never uses SUPABASE_DB_URL, TEST_DB_URL, .env or a TCP connection.
 * Start/prepare the disposable fixture separately; this suite never starts it.
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = process.env.RUN_DEMO_RECEIPTS_DB_TESTS === "disposable";
const org = "10000000-0000-4000-8000-000000000001";
const foreign = "10000000-0000-4000-8000-000000000002";
const channel = "c67e9f8a-8719-4481-9154-ed8a464f85bd";
const other = "20000000-0000-4000-8000-000000000002";
let pool: Pool;
let authorized = false;
let sequence = 0;
function input(body = "Hello", sentAt = new Date(Date.now() - 500)) {
  const id = `disposable-${++sequence}`;
  const source = JSON.stringify({
    external_id: id,
    waba_id: "111",
    phone_number_id: "222",
    from: "1555555" + String(sequence).padStart(4, "0"),
    sent_at: sentAt.toISOString(),
    type: "text",
    body,
    profile_name: "Synthetic fixture",
    media_url: null,
    media_mime: null,
    metadata: {},
  });
  return [
    "disposable-token",
    org,
    channel,
    "111",
    "222",
    new Date().toISOString(),
    source,
    createHash("sha256").update(source).digest("hex"),
    body === "STOP",
  ];
}
const rpc =
  "select public.fn_demo_ingest_meta($1,$2::uuid,$3::uuid,$4,$5,$6::timestamptz,$7,$8,$9::boolean) as receipt";
async function ingest(args: unknown[]) {
  return (await pool.query(rpc, args)).rows[0].receipt;
}
async function count(table: string, field: string, value: unknown) {
  // Both identifiers are hardcoded by the tests below, never external input.
  return Number(
    (await pool.query(`select count(*) as n from public.${table} where ${field}=$1`, [value]))
      .rows[0].n,
  );
}

describe.skipIf(!enabled)("atomic demo receipt: real disposable PostgreSQL", () => {
  beforeAll(async () => {
    const raw = process.env.DEMO_RECEIPT_TEST_SOCKET ?? "";
    if (!/^\/private\/tmp\/zsai-demo-pg-[a-zA-Z0-9_-]+$/.test(raw) || realpathSync(raw) !== raw)
      throw Error("a dedicated private disposable Unix socket is required");
    pool = new Pool({
      host: raw,
      port: 55432,
      database: "zsai_demo_receipts_test",
      user: "postgres",
      password: "",
      ssl: false,
      options: "",
      max: 6,
      statement_timeout: 10_000,
      lock_timeout: 5_000,
    });
    const check = (
      await pool.query(`select current_database() as db, inet_server_addr() is null as socket,
      current_setting('zero_salary.disposable_test',true) as marker`)
    ).rows[0];
    expect(check).toEqual({ db: "zsai_demo_receipts_test", socket: true, marker: "receipts_v1" });
    for (const table of ["messages", "contacts", "channel_sessions", "demo_inbound_receipts"])
      expect(
        Number((await pool.query(`select count(*) as n from public.${table}`)).rows[0].n),
      ).toBe(0);
    authorized = true;
    await pool.query(
      `insert into public.organizations(id,slug,legal_name,display_name)
      values($1,'demo-receipt-test','Synthetic fixture','Synthetic fixture'),
      ($2,'demo-receipt-foreign','Synthetic foreign fixture','Synthetic foreign fixture')`,
      [org, foreign],
    );
    await pool.query(
      `insert into public.channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted,
      provider,webhook_path_token,meta_waba_id,meta_phone_number_id,phone_number,metadata,status)
      values($1,$2,'disposable-demo',decode('00','hex'),'meta_cloud','disposable-token','111','222','+15555550230','{"ai_gate":"open"}','WORKING'),
      ($3,$2,'disposable-off',decode('00','hex'),'meta_cloud','disposable-other','333','444','+15555557270','{"ai_gate":"off"}','WORKING')`,
      [channel, org, other],
    );
  });
  afterAll(async () => {
    if (!pool) return;
    try {
      if (authorized) {
        await pool.query("delete from public.demo_inbound_receipts where organization_id=$1", [
          org,
        ]);
        await pool.query("delete from public.organizations where id=any($1::uuid[])", [
          [org, foreign],
        ]);
      }
    } finally {
      await pool.end();
    }
  });
  it("serializes concurrent deliveries into one message/event and one unread increment", async () => {
    const args = input();
    const receipts = await Promise.all(Array.from({ length: 5 }, () => ingest(args)));
    expect(new Set(receipts.map((r) => r.message_id)).size).toBe(1);
    expect(new Set(receipts.map((r) => r.dispatch_event_id)).size).toBe(1);
    expect(receipts.filter((r) => !r.duplicate)).toHaveLength(1);
    const r = receipts[0];
    expect(await count("messages", "id", r.message_id)).toBe(1);
    expect(await count("event_log", "entity_id", r.message_id)).toBe(1);
    const v = (
      await pool.query(
        "select unread_count_for_assignee,reply_context_revision from public.conversations where id=$1",
        [r.conversation_id],
      )
    ).rows[0];
    expect(v.unread_count_for_assignee).toBe(1);
    expect(Number(v.reply_context_revision)).toBeGreaterThanOrEqual(1);
    const before = JSON.stringify(v);
    expect((await ingest(args)).duplicate).toBe(true);
    expect(
      JSON.stringify(
        (
          await pool.query(
            "select unread_count_for_assignee,reply_context_revision from public.conversations where id=$1",
            [r.conversation_id],
          )
        ).rows[0],
      ),
    ).toBe(before);
  });
  it("contains generic message, demand and routing trigger side effects", async () => {
    const r = await ingest(input());
    expect(await count("event_log", "payload->>'message_id'", r.message_id)).toBe(0);
    expect(await count("event_log", "payload->>'conversation_id'", r.conversation_id)).toBe(1); // intended dispatch only
    expect(await count("demanda_conversas", "conversation_id", r.conversation_id)).toBe(0);
    await expect(
      pool.query(
        `select public.emit_event('ai_agent.dispatch_requested','message',$1,
      '{}'::jsonb,'{}'::jsonb,$2)`,
        [r.message_id, org],
      ),
    ).rejects.toThrow("demo_inbound_denied");
    await expect(
      pool.query(
        `select public.emit_event('ai_agent.dispatch_requested','message',gen_random_uuid(),
      jsonb_build_object('inbound_message_id',$1::text),'{}'::jsonb,$2)`,
        [r.message_id, org],
      ),
    ).rejects.toThrow("demo_inbound_denied");
    await expect(
      pool.query(
        `select public.emit_event('message.received','message',gen_random_uuid(),
      jsonb_build_object('message_id',$1::text),'{}'::jsonb,$2)`,
        [r.message_id, org],
      ),
    ).rejects.toThrow("demo_inbound_denied");
    expect(await count("event_log", "entity_id", r.message_id)).toBe(1);
  });
  it("recovers commit uncertainty from the stored receipt, without another event", async () => {
    const args = input();
    const committed = await ingest(args); // discard caller acknowledgement
    const retry = await ingest(args);
    expect(retry).toEqual({ ...committed, duplicate: true });
    expect(await count("event_log", "entity_id", retry.message_id)).toBe(1);
  });
  it("rolls back opt-out failure and safely retries the entire transaction", async () => {
    const args = input("STOP");
    const id = JSON.parse(String(args[6])).external_id;
    await pool.query(`create or replace function public.disposable_fail_optout() returns trigger
      language plpgsql as $$ begin if new.is_blocked is true then raise exception 'disposable optout failure'; end if; return new; end $$;
      create trigger disposable_fail_optout before update of is_blocked on public.contacts
      for each row execute function public.disposable_fail_optout()`);
    try {
      await expect(ingest(args)).rejects.toThrow("disposable optout failure");
    } finally {
      await pool.query(
        "drop trigger disposable_fail_optout on public.contacts; drop function public.disposable_fail_optout()",
      );
    }
    expect(await count("messages", "external_id", id)).toBe(0);
    expect(await count("demo_inbound_receipts", "meta_message_id", id)).toBe(0);
    const r = await ingest(args);
    expect(r.outcome).toBe("opted_out");
    expect(r.dispatch_event_id).toBeNull();
    expect(
      (
        await pool.query(
          "select is_blocked from public.contacts where id=(select contact_id from public.messages where id=$1)",
          [r.message_id],
        )
      ).rows[0].is_blocked,
    ).toBe(true);
  });
  it.each(["blocked", "human"])("preserves %s state without dispatch", async (state) => {
    const args = input();
    const sender = JSON.parse(String(args[6])).from;
    const contact = (
      await pool.query("select public.fn_upsert_wa_contact($1,'phone',$2,null,$3,null) as id", [
        org,
        "+" + sender,
        sender,
      ])
    ).rows[0].id;
    await pool.query(`update public.contacts set is_blocked=$2,force_human=$3 where id=$1`, [
      contact,
      state === "blocked",
      state === "human",
    ]);
    const r = await ingest(args);
    expect(r.outcome).toBe(state === "blocked" ? "blocked" : "human_takeover");
    expect(r.dispatch_event_id).toBeNull();
  });
  it.each(["tenant", "channel", "transport", "token", "fingerprint", "old"])(
    "denies %s before durable mutations",
    async (fault) => {
      const args = input("Hello", fault === "old" ? new Date(Date.now() - 600_000) : undefined);
      if (fault === "tenant") args[1] = foreign;
      if (fault === "channel") args[2] = other;
      if (fault === "transport") args[4] = "444";
      if (fault === "token") args[0] = "other";
      if (fault === "fingerprint") args[7] = "0".repeat(64);
      await expect(ingest(args)).rejects.toThrow();
      expect(await count("messages", "external_id", JSON.parse(String(args[6])).external_id)).toBe(
        0,
      );
    },
  );
  it("denies changed immutable payload and invalid pending receipt", async () => {
    const args = input();
    const r = await ingest(args);
    const altered = [...args];
    const e = JSON.parse(String(args[6]));
    e.body = "Changed";
    altered[6] = JSON.stringify(e);
    altered[7] = createHash("sha256").update(String(altered[6])).digest("hex");
    await expect(ingest(altered)).rejects.toThrow();
    const client = await pool.connect();
    try {
      await client.query("begin");
      await client.query(
        "update public.demo_inbound_receipts set outcome='pending',dispatch_event_id=null,completed_at=null where message_id=$1",
        [r.message_id],
      );
      await expect(client.query(rpc, args)).rejects.toThrow("demo_inbound_denied");
    } finally {
      await client.query("rollback");
      client.release();
    }
    expect(await count("event_log", "entity_id", r.message_id)).toBe(1);
  });
  it("preserves normal trigger behavior for a non-demo channel", async () => {
    const contact = (
      await pool.query(
        "select public.fn_upsert_wa_contact($1,'phone','+15555559999',null,'15555559999',null) as id",
        [org],
      )
    ).rows[0].id;
    const conversation = (
      await pool.query("select public.fn_upsert_wa_conversation($1,$2,$3) as id", [
        org,
        contact,
        other,
      ])
    ).rows[0].id;
    const m = (
      await pool.query(
        `insert into public.messages(organization_id,channel_session_id,contact_id,conversation_id,direction,status,type,body,external_id,sent_at)
      values($1,$2,$3,$4,'inbound','delivered','text','Synthetic normal','disposable-normal',clock_timestamp()) returning id`,
        [org, other, contact, conversation],
      )
    ).rows[0].id;
    expect(await count("event_log", "payload->>'message_id'", m)).toBe(1);
    expect(await count("demo_inbound_receipts", "message_id", m)).toBe(0);
  });
  it("denies legacy message adoption without a receipt", async () => {
    const args = input();
    const e = JSON.parse(String(args[6]));
    const contact = (
      await pool.query("select public.fn_upsert_wa_contact($1,'phone',$2,null,$3,null) as id", [
        org,
        "+" + e.from,
        e.from,
      ])
    ).rows[0].id;
    const conversation = (
      await pool.query("select public.fn_upsert_wa_conversation($1,$2,$3) as id", [
        org,
        contact,
        channel,
      ])
    ).rows[0].id;
    await pool.query(
      `insert into public.messages(organization_id,channel_session_id,contact_id,conversation_id,direction,status,type,body,external_id,sent_at)
      values($1,$2,$3,$4,'inbound','delivered','text',$5,$6,$7::timestamptz)`,
      [org, channel, contact, conversation, e.body, e.external_id, e.sent_at],
    );
    await expect(ingest(args)).rejects.toThrow("demo_inbound_denied");
    expect(await count("demo_inbound_receipts", "meta_message_id", e.external_id)).toBe(0);
  });
  it("never adopts or mutates a preexisting foreign-tenant contact", async () => {
    const args = input();
    const e = JSON.parse(String(args[6]));
    const foreignContact = (
      await pool.query(
        "select public.fn_upsert_wa_contact($1,'phone',$2,null,$3,'Foreign owner') as id",
        [foreign, "+" + e.from, e.from],
      )
    ).rows[0].id;
    const before = (
      await pool.query("select to_jsonb(c) as row from public.contacts c where id=$1", [
        foreignContact,
      ])
    ).rows[0].row;
    const receipt = await ingest(args);
    const binding = (
      await pool.query("select organization_id,contact_id from public.messages where id=$1", [
        receipt.message_id,
      ])
    ).rows[0];
    expect(binding.organization_id).toBe(org);
    expect(binding.contact_id).not.toBe(foreignContact);
    expect(
      (
        await pool.query("select to_jsonb(c) as row from public.contacts c where id=$1", [
          foreignContact,
        ])
      ).rows[0].row,
    ).toEqual(before);
    expect(await count("conversations", "contact_id", foreignContact)).toBe(0);
  });
  it("rejects a competing uncommitted contact without adoption or mutation", async () => {
    const args = input();
    const e = JSON.parse(String(args[6]));
    const competitor = await pool.connect();
    const request = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await competitor.query("begin");
      const foreignContact = (
        await competitor.query(
          "select public.fn_upsert_wa_contact($1,'phone',$2,null,$3,'Concurrent owner') as id",
          [org, "+" + e.from, e.from],
        )
      ).rows[0].id;
      const before = (
        await competitor.query("select to_jsonb(c) as row from public.contacts c where id=$1", [
          foreignContact,
        ])
      ).rows[0].row;
      const requestPid = (await request.query("select pg_backend_pid() as pid")).rows[0].pid;
      const competitorPid = (await competitor.query("select pg_backend_pid() as pid")).rows[0].pid;
      // Observe the real unique-index wait before committing the competitor.
      // Attach rejection handling immediately so a failure cannot leak a promise.
      pending = request.query(rpc, args).then(
        (result) => ({ result, error: null }),
        (error: Error) => ({ result: null, error }),
      );
      let waiting = false;
      for (let attempt = 0; attempt < 80; attempt++) {
        waiting = (
          await pool.query("select $1::int=any(pg_blocking_pids($2)) as waiting", [
            competitorPid,
            requestPid,
          ])
        ).rows[0].waiting;
        if (waiting) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(waiting).toBe(true);
      await competitor.query("commit");
      const outcome = (await pending) as { result: unknown; error: Error | null };
      expect(outcome.result).toBeNull();
      expect(outcome.error?.message).toContain("demo_inbound_denied");
      expect(
        (
          await pool.query("select to_jsonb(c) as row from public.contacts c where id=$1", [
            foreignContact,
          ])
        ).rows[0].row,
      ).toEqual(before);
      expect(await count("messages", "external_id", e.external_id)).toBe(0);
      expect(await count("demo_inbound_receipts", "meta_message_id", e.external_id)).toBe(0);
      expect(await count("conversations", "contact_id", foreignContact)).toBe(0);
    } finally {
      await competitor.query("rollback");
      if (pending) await pending;
      request.release();
      competitor.release();
    }
  });
  it("revokes client receipt access and execution", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin; set local role authenticated");
      await expect(client.query("select * from public.demo_inbound_receipts")).rejects.toThrow();
    } finally {
      await client.query("rollback");
      client.release();
    }
    const grants = (
      await pool.query(`select has_function_privilege('anon','public.fn_demo_ingest_meta(text,uuid,uuid,text,text,timestamptz,text,text,boolean)','execute') as anon,
      has_function_privilege('authenticated','public.fn_demo_ingest_meta(text,uuid,uuid,text,text,timestamptz,text,text,boolean)','execute') as client`)
    ).rows[0];
    expect(grants).toEqual({ anon: false, client: false });
  });
});
