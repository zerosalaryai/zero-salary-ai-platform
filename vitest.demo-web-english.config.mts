import { defineConfig } from "vitest/config";
import demo from "./vitest.demo-inbound.config.mts";

// Reuse network/DB denial and aliases, replacing (not merging) the suite list.
export default defineConfig({
  ...demo,
  test: { ...demo.test, include: ["tests/unit/demo-web-english-*.test.tsx"] },
});
