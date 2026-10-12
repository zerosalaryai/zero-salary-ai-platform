import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  // Vite normally searches the repository for .env files. Pointing envDir at
  // an intentionally absent test-only directory makes explicit process vars
  // the sole configuration source for this harness.
  envDir: path.resolve(__dirname, "tests/integration/.env-disabled"),
  test: {
    environment: "node",
    include: [
      "tests/integration/external-runtime-v2-isolated.test.ts",
      "lib/agent-engine/external/accepted-response-ledger.test.ts",
      "lib/agent-engine/external/generation.test.ts",
      "lib/agent-engine/external/python-agent-client.test.ts",
      "tests/unit/external-agent-inbound-turn.test.ts",
      "tests/unit/external-checkpoint-v2.test.ts",
      "tests/unit/structured-lead-capture.test.ts",
    ],
    setupFiles: [],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    pool: "forks",
    maxWorkers: 1,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
      "server-only": path.resolve(
        __dirname,
        "node_modules/next/dist/compiled/server-only/empty.js",
      ),
    },
  },
});
