import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
const root = process.cwd();
const runtime = path.join(root, "workers/agent-worker/node-runtime.cjs");
const guard = path.join(root, "tests/fixtures/worker-network-denied.cjs");
const env = {
  PATH: process.env.PATH, NODE_ENV: "production", SENTRY_DSN: "off",
  NEXT_PUBLIC_SUPABASE_URL: "https://synthetic.invalid", NEXT_PUBLIC_SUPABASE_ANON_KEY: "synthetic",
  SUPABASE_SERVICE_ROLE_KEY: "synthetic", SUPABASE_DB_URL: "postgresql://synthetic:synthetic@127.0.0.1:1/synthetic",
  DEMO_INBOUND_ONLY: "true", DEMO_CHANNEL_ID: "c67e9f8a-8719-4481-9154-ed8a464f85bd",
  DEMO_CRM_OPERATIONAL: "true", DEMO_WEB_INGRESS_ONLY: "false", ZSAI_AGENT_RUNTIME: "python",
  ZSAI_PYTHON_AGENT_URL: "https://synthetic.invalid", ZSAI_INTERNAL_AGENT_SECRET: "synthetic",
  INTERNAL_SECRET: "synthetic", CPF_ENCRYPTION_KEY: "synthetic", WAHA_BYO_ENCRYPTION_KEY: "synthetic",
  AI_CRED_AES_KEY: "synthetic", WAHA_API_BASE_URL: "https://synthetic.invalid", WAHA_API_KEY: "synthetic",
  WAHA_WEBHOOK_BASE_URL: "https://synthetic.invalid", UPSTASH_REDIS_REST_URL: "https://synthetic.invalid", UPSTASH_REDIS_REST_TOKEN: "synthetic",
};
describe("standalone Worker Node boundary", () => {
  it("loads the complete eager graph and stops at the first denied network operation", () => {
    const script = JSON.parse(readFileSync("package.json", "utf8")).scripts["worker:runtime"] as string;
    expect(script).toBe("node --require ./workers/agent-worker/node-runtime.cjs --import tsx workers/agent-worker/main.ts");
    const r = spawnSync(process.execPath, ["--require", guard, ...script.split(" ").slice(1)], {cwd:root, env, encoding:"utf8", timeout:20000});
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("boot falhou: SYNTHETIC_NETWORK_BLOCKED");
    expect(r.stderr).not.toMatch(/Cannot find module|ERR_MODULE_NOT_FOUND|cannot be imported from a Client/);
    expect(readFileSync("Dockerfile.worker", "utf8")).toContain('CMD ["pnpm", "run", "worker:runtime"]');
  });
  it("resolves server-only for both CJS and ESM only under the explicit Worker preload", () => {
    for (const args of [["-e", "require('server-only')"], ["--input-type=module", "-e", "import 'server-only'"]]) {
      const r = spawnSync(process.execPath, ["--require", runtime, ...args], {cwd:root, env, encoding:"utf8"});
      expect(r.status, r.stderr).toBe(0);
    }
    const r = spawnSync(process.execPath, ["-e", "require('server-only')"], {cwd:root, env, encoding:"utf8"});
    expect(r.status).not.toBe(0);
  });
  it("preserves Next's poison pill and staff authorization module unchanged", () => {
    const r = spawnSync(process.execPath, ["-e", "require('next/dist/compiled/server-only/index.js')"], {cwd:root, env, encoding:"utf8"});
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("cannot be imported from a Client Component");
    expect(readFileSync("lib/channels/demo-staff-delivery.ts", "utf8")).toMatch(/^import "server-only";/);
  });
});
