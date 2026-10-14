import { defineConfig } from "vitest/config";
export default defineConfig({
  envDir: false,
  test: { environment: "node", include: ["tests/invariants/inbound-coalescing-operators.test.ts"],
    fileParallelism: false, testTimeout: 20000 },
});
