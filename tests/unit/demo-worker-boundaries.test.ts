import { runInNewContext } from "node:vm";
import ts from "typescript";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WahaClient } from "@/lib/waha/client";
import { readDemoConfig } from "@/lib/channels/demo-inbound-only";
import { claimJobs } from "@/lib/agent-engine/queue/queue";
import { drainTick } from "@/lib/agent-engine/edge/crm/drain";
import { metaCloudAdapter } from "@/lib/channels/adapters/meta-cloud";
import { sendTemplate } from "@/lib/channels/meta/send-template";
import type { DemoBinding } from "@/lib/channels/demo-inbound-only";

const demo: DemoBinding = {
  channelId: "c67e9f8a-8719-4481-9154-ed8a464f85bd",
  organizationId: "11000000-0000-4000-8000-000000000003",
  startedAt: "2026-10-10T00:00:00Z",
};
const knobs = {
  batchSize: 10,
  intervalMs: 0,
  idleIntervalMs: 0,
  debounceMs: 0,
  reapTimeoutMs: 60000,
};
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;
afterEach(() => vi.unstubAllEnvs());

describe("claim e drain: escopo ANTES das mutações", () => {
  it("demo: claim SQL cruza fonte durável, tenant, canal e corte de frescor", async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("count(*)") ? [{ n: 0 }] : [],
    }));
    const client = { query, release: vi.fn() };
    const pool = { connect: vi.fn(async () => client) };
    await claimJobs(pool as never, { workerId: "demo", maxConcurrency: 1, demo });
    const call = query.mock.calls.find(([sql]) => sql.includes("with dedup"))!;
    const sql = call[0];
    for (const guard of [
      "j.kind='inbound_turn'",
      "j.organization_id=$4",
      "cs.id=$3",
      "j.created_at >= $5",
      "e.created_at >= $5",
      "m.created_at >= $5",
      "m.direction='inbound'",
      "e.id=j.source_event_id",
      "cv.contact_id=j.contact_id",
      "e.payload->>'channel_session_id'=cs.id::text",
      "cs.metadata->>'ai_gate'='open'",
    ])
      expect(sql).toContain(guard);
    expect(query).toHaveBeenCalledWith(sql, [
      1,
      "demo",
      demo.channelId,
      demo.organizationId,
      demo.startedAt,
    ]);
    expect(sql.indexOf("j.kind='inbound_turn'")).toBeLessThan(sql.indexOf("for update of j"));
  });
  it("claim direto em demo exige binding antes de conectar ou mutar jobs", async () => {
    vi.stubEnv("DEMO_INBOUND_ONLY", "true");
    vi.stubEnv("DEMO_CHANNEL_ID", demo.channelId);
    const pool = { connect: vi.fn() };
    for (const binding of [
      undefined,
      { ...demo, channelId: "c67e9f8a-0000-4000-8000-000000000001" },
      { ...demo, organizationId: "invalid" },
    ]) {
      await expect(
        claimJobs(pool as never, { workerId: "demo", maxConcurrency: 1, demo: binding }),
      ).rejects.toThrow("demo_inbound_only_denied");
    }
    expect(pool.connect).not.toHaveBeenCalled();
  });
  it("configuração de processo inválida não pode ser contornada por opções de claim", async () => {
    vi.stubEnv("DEMO_INBOUND_ONLY", "unknown");
    const pool = { connect: vi.fn() };
    await expect(
      claimJobs(pool as never, { workerId: "demo", maxConcurrency: 1, demo }),
    ).rejects.toThrow("demo_inbound_only_denied");
    expect(pool.connect).not.toHaveBeenCalled();
  });
  it("normal conserva o claim anterior sem escopo demo", async () => {
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes("count(*)") ? [{ n: 0 }] : [],
    }));
    await claimJobs({ connect: vi.fn(async () => ({ query, release: vi.fn() })) } as never, {
      workerId: "normal",
      maxConcurrency: 2,
    });
    const sql = query.mock.calls.find(([text]) => text.includes("with dedup"))![0];
    expect(sql).not.toContain("join event_log");
    expect(query).toHaveBeenCalledWith(sql, [2, "normal"]);
  });
  it("eventos antigos não são adquiridos; nenhum reaper global", async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [] }));
    expect(await drainTick({ query } as never, { ...knobs, demo }, log)).toBe(0);
    expect(query).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledWith(expect.stringContaining("ev.created_at >= $5"), [
      10,
      "agent-engine",
      demo.organizationId,
      demo.channelId,
      demo.startedAt,
    ]);
    const sql = query.mock.calls[0]![0] as unknown as string;
    for (const guard of [
      "cs.id=$4",
      "ev.organization_id=$3",
      "m.direction='inbound'",
      "ev.payload->>'contact_id'=cv.contact_id::text",
    ])
      expect(sql).toContain(guard);
  });
  it("erro de DB não pode disparar job", async () => {
    const query = vi.fn().mockRejectedValue(new Error("db unavailable"));
    await expect(drainTick({ query } as never, { ...knobs, demo }, log)).rejects.toThrow();
    expect(query).toHaveBeenCalledOnce();
  });
});

describe("transporte real proibido sem contexto demo", () => {
  it("adapter direto e templates não podem contatar o provider", async () => {
    vi.stubEnv("DEMO_INBOUND_ONLY", "true");
    vi.stubEnv("DEMO_CHANNEL_ID", demo.channelId);
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockClear();
    await expect(
      metaCloudAdapter.send({
        organizationId: demo.organizationId,
        sessionRef: "123",
        to: "15555550111",
        kind: "text",
        body: "hello",
      }),
    ).rejects.toThrow("demo_inbound_only_denied");
    await expect(sendTemplate({} as never)).rejects.toThrow("demo_inbound_only_denied");
    const raw = new WahaClient("https://test-placeholder.invalid", "synthetic-key");
    await expect(
      raw.sendMessage("unrelated-session", "synthetic-recipient", "hello"),
    ).rejects.toThrow("demo_inbound_only_denied");
    await expect(
      raw.setPresence("unrelated-session", "synthetic-recipient", "typing"),
    ).rejects.toThrow("demo_inbound_only_denied");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// Lê o wiring sem importar main.ts: importar esse arquivo inicia o worker.
describe("boot: nenhum replay, cron ou tick global em demo", () => {
  const source = readFileSync("workers/agent-worker/main.ts", "utf8");
  it("valida a configuração e a linha do canal antes do primeiro efeito de boot", () => {
    expect(source.indexOf("readDemoConfig(env)")).toBeLessThan(
      source.indexOf("const pool = createPool"),
    );
    expect(source.indexOf("await bindDemoChannel(")).toBeLessThan(
      source.indexOf("await seedPlatformPlaybook("),
    );
    expect(source).toContain("demo ? null : await seedPlatformPlaybook(pool)");
    expect(source).toContain("demo ? { revived: 0, dead: 0 } : await reapExpiredJobs");
  });
  it("boot executa config, binding e ativação nesta ordem; erros abortam antes do schema/loops", async () => {
    const ast = ts.createSourceFile("worker.ts", source, ts.ScriptTarget.Latest, true);
    const fn = ast.statements.find(
      (node): node is ts.FunctionDeclaration =>
        ts.isFunctionDeclaration(node) && node.name?.text === "startWorker",
    )!;
    const statements = fn.body!.statements;
    const end = statements.findIndex((node) =>
      node.getText(ast).includes("await assertHarnessSchema(pool)"),
    );
    expect(end).toBeGreaterThan(0);
    const boot = `(async () => { ${statements
      .slice(0, end + 1)
      .map((node) => node.getText(ast))
      .join("\n")} })()`;
    for (const fault of ["none", "recovery", "config", "binding", "activation"]) {
      const calls: string[] = [];
      const step = (name: string) => {
        calls.push(name);
        if (fault === name) throw new Error("denied");
      };
      const promise = runInNewContext(boot, {
        env: { DEMO_INBOUND_ONLY: "true", DEMO_CHANNEL_ID: demo.channelId },
        denyDemoWebAction: () => undefined,
        demoCrmRecovery: () => { step("recovery"); return false; },
        readDemoConfig: (env: Record<string, unknown>) => {
          step("config");
          return readDemoConfig(env);
        },
        createPool: () => {
          step("pool");
          return {};
        },
        bindDemoChannel: async () => {
          step("binding");
          return demo;
        },
        activateDemoWorker: () => step("activation"),
        assertHarnessSchema: async () => step("schema"),
        hostname: () => "synthetic",
        process: { pid: 1 },
        log: {},
      });
      if (fault === "none") {
        await promise;
        expect(calls).toEqual(["recovery", "config", "pool", "binding", "activation", "schema"]);
      } else {
        await expect(promise).rejects.toThrow("denied");
        expect(calls.at(-1)).toBe(fault);
        expect(calls).not.toContain("schema");
      }
    }
    expect(source.indexOf("if (demo) activateDemoWorker(demo)")).toBeLessThan(
      source.indexOf("claimar: () => claimJobs"),
    );
  });
  it("event-log, cron, saúde, flywheel, watchdogs e timers são pulados, inclusive o primeiro tick", () => {
    for (const call of ["runEventLogDrainLoop", "runCronLoop", "runHealthLoop"])
      expect(source).toContain(`demo ? Promise.resolve() : ${call}(`);
    expect(source).toContain("const reaperTimer = demo ? undefined : setInterval(");
    expect(source).toContain("const holdsTimer = demo ? undefined : setInterval(");
    expect(source).toContain("!demo && env.WAHA_API_BASE_URL");
    expect(source).toContain("!demo && env.WACALLS_API_BASE_URL");
    expect(source).toContain("!demo && env.FLYWHEEL_INTERVAL_MS > 0");
    expect(source).toContain("withDemoInbound(pool, demo, job, execute)");
    expect(source).toContain("maxConcurrency: env.QUEUE_MAX_CONCURRENCY, demo");
  });
  it.each([
    ["cronLoop", "runCronLoop"],
    ["eventLogLoop", "runEventLogDrainLoop"],
    ["healthLoop", "runHealthLoop"],
  ])(
    "wiring real %s: nenhum primeiro tick em demo; normal preservado",
    (variable, functionName) => {
      const ast = ts.createSourceFile("worker.ts", source, ts.ScriptTarget.Latest, true);
      let expression = "";
      const visit = (node: ts.Node): void => {
        if (
          ts.isVariableDeclaration(node) &&
          node.name.getText(ast) === variable &&
          node.initializer
        )
          expression = node.initializer.getText(ast);
        ts.forEachChild(node, visit);
      };
      visit(ast);
      expect(expression).not.toBe("");
      const start = vi.fn(async () => undefined);
      // Avalia somente a expressão de ativação, com dependências falsas.
      // Não importa main.ts nem o código real de um loop.
      for (const enabled of [true, false]) {
        start.mockClear();
        runInNewContext(expression, {
          demo: enabled ? demo : undefined,
          [functionName]: start,
          pool: {},
          env: {},
          log: {},
          loopsAbort: { signal: {} },
        });
        expect(start).toHaveBeenCalledTimes(enabled ? 0 : 1);
      }
    },
  );
  it("os dois catches inbound recusam degradação aberta somente em demo", () => {
    const inbound = readFileSync("lib/agent-engine/agent/inbound-turn.ts", "utf8");
    expect(
      inbound.match(/if \(demoInboundOnly\(\)\) throw new DemoIsolationError\(\);/g),
    ).toHaveLength(2);
    expect(
      inbound.match(
        /if \(demoInboundOnly\(\) && elegib === null\) throw new DemoIsolationError\(\);/g,
      ),
    ).toHaveLength(2);
    expect(inbound).toContain("!demoInboundOnly() && followupKnobs !== undefined");
    expect(inbound).toContain(
      "!demoInboundOnly() && agentConfig !== null && agentConfig.toolIds.length > 0",
    );
    expect(inbound).toContain("papelLigado: !demoInboundOnly()");
  });
  it("barreiras compartilhadas antes do ledger e antes de cada transporte", () => {
    const sink = readFileSync("lib/agent-engine/edge/crm/send-message.ts", "utf8");
    expect(sink.indexOf("await assertDemoOutbound(input.tenantId")).toBeLessThan(
      sink.indexOf("return sendWithLedger("),
    );
    const handler = readFileSync("app/api/v1/messages/_handler.ts", "utf8");
    expect(handler).toContain(
      "const checkBoundary = async () => {\n        await assertDemoOutbound",
    );
    const provider = readFileSync("lib/channels/adapters/meta-cloud.ts", "utf8");
    expect(provider).toContain(
      "await envelope.beforeSend?.();\n    await assertDemoTransport({ ...envelope, sessionRef: creds.phoneNumberId });\n    const res = await fetch(",
    );
  });
});
