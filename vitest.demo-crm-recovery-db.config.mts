import { defineConfig } from "vitest/config";
export default defineConfig({envDir:false,test:{environment:"node",include:["tests/invariants/demo-crm-recovery.test.ts"],fileParallelism:false,testTimeout:20000,hookTimeout:30000}});
