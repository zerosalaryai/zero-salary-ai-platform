import { defineConfig } from "vitest/config";
// No .env loading and no shared DB_URL/TEST_DB_URL fallback.
export default defineConfig({
  envDir: false,
  test: {
    environment: "node",
    include: ["tests/invariants/demo-inbound-receipts.test.ts"],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
