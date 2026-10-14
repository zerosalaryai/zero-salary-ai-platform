/** SELECT-only operator regression; never falls back to environment DB URLs. */
import { realpathSync, readFileSync } from "node:fs";
import { Pool } from "pg";
import { expect, it } from "vitest";

it.skipIf(process.env.RUN_DEMO_RECEIPTS_DB_TESTS !== "disposable")(
  "PostgreSQL resolves the actual inbound coalescing SQL and preserves boundary compatibility",
  async () => {
    const socket = process.env.DEMO_RECEIPT_TEST_SOCKET ?? "";
    if (!/^\/private\/tmp\/zsai-demo-pg-[a-zA-Z0-9_-]+$/.test(socket) || realpathSync(socket) !== socket)
      throw Error("private disposable socket required");
    const pool = new Pool({ host: socket, port: 55432, database: "zsai_demo_receipts_test",
      user: "postgres", password: "", ssl: false, options: "", max: 1, statement_timeout: 5000 });
    try {
      const identity = (await pool.query(`select current_database() as db, inet_server_addr() is null as socket,
        current_setting('zero_salary.disposable_test',true) as marker`)).rows[0];
      expect(identity).toEqual({ db: "zsai_demo_receipts_test", socket: true, marker: "receipts_v1" });
      // Prove the original operator error rather than mocking its SQL text.
      await expect(pool.query(`select '{}'::jsonb->'service_boundary' - 'demanda_id' - 'demanda_revision'`))
        .rejects.toMatchObject({ code: "42725" });
      const source = readFileSync("lib/agent-engine/edge/crm/drain.ts", "utf8");
      const sql = source.match(/`(select id from job_queue[\s\S]*?limit 1)`/)?.[1];
      expect(sql).toBeTruthy();
      const org = "10000000-0000-4000-8000-000000000001";
      const contact = "20000000-0000-4000-8000-000000000001";
      const expected = { organization_id: org, contact_id: contact,
        conversation_id: "30000000-0000-4000-8000-000000000001", service_revision: 2,
        demanda_id: "40000000-0000-4000-8000-000000000001", demanda_revision: 1 };
      // CTE shadows the real table: all candidates are synthetic, no writes/data reads.
      const cte = `with job_queue as (select 'synthetic'::text as id, $1::uuid as organization_id,
        $2::uuid as contact_id, 'inbound_turn'::text as kind, 'pending'::text as status,
        now()+interval '1 minute' as run_after, $4::jsonb as payload) `;
      for (const [boundary, allowed] of [
        [expected, true],
        [{ ...expected, demanda_id: null, demanda_revision: null }, true],
        [null, false],
        ["malformed", false],
        [1, false],
        [[], false],
        [{ ...expected, organization_id: "foreign" }, false],
        [{ ...expected, conversation_id: "foreign" }, false],
        [{ ...expected, service_revision: 3 }, false],
        [{ ...expected, demanda_id: "foreign" }, false],
        [{ ...expected, demanda_revision: 2 }, false],
      ] as const) {
        const result = await pool.query(cte + sql, [org, contact, JSON.stringify(expected),
          JSON.stringify({ service_boundary: boundary })]);
        expect(result.rows).toEqual(allowed ? [{ id: "synthetic" }] : []);
      }
    } finally { await pool.end(); }
  },
);
