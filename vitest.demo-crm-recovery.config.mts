import { defineConfig } from "vitest/config";
import base from "./vitest.demo-inbound.config.mts";
export default defineConfig({...base, test: {...base.test, include: ["tests/unit/demo-crm-recovery*.test.ts*", "lib/agent-engine/external/python-agent-client.test.ts"]}});
