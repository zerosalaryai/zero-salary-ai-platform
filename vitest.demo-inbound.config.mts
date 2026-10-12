import { defineConfig } from "vitest/config";
import path from "node:path";

// Bancada local sem setup que lê .env e sem importação do entrypoint do worker.
export default defineConfig({
  envDir: false,
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "."),
      "server-only": path.resolve(
        import.meta.dirname,
        "node_modules/next/dist/compiled/server-only/empty.js",
      ),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./tests/setup/demo-no-network.ts"],
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "https://test-placeholder.invalid",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-placeholder-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "test-placeholder-service-role-key",
      DEMO_INBOUND_ONLY: "false",
    },
    include: [
      "tests/unit/demo-inbox-read.test.ts",
      "tests/unit/aviso-de-escalacao-reply-language.test.ts",
      "tests/unit/demo-sender-scheduler.test.ts",
      "lib/automation/actions/send-ai-message.test.ts",
      "app/api/v1/cron/agenda-reminder/route.test.ts",
      "tests/unit/demo-receipt-sql.test.ts",
      "tests/unit/demo-duplicate-inbound.test.ts",
      "tests/unit/demo-meta-credentials.test.ts",
      "tests/unit/app-da-meta-credencial-do-banco.test.ts",
      "tests/unit/demo-web-boundaries.test.ts",
      "tests/unit/demo-web-ingress.test.ts",
      "tests/unit/demo-web-route.test.ts",
      "tests/unit/demo-inbound-only.test.ts",
      "tests/unit/demo-worker-boundaries.test.ts",
      "lib/ai/elegibilidade/gate.test.ts",
      "lib/ai/elegibilidade/consulta-supabase.test.ts",
      "lib/agent-engine/edge/crm/drain.test.ts",
      "tests/unit/assistido-respeita-o-gate.test.ts",
    ],
  },
});
