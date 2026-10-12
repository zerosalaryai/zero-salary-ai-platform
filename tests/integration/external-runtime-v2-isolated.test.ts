import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelAdapter, OutboundEnvelope } from "@/lib/channels/types";
import {
  externalAgentTurnResponseSchema,
  type ExternalAgentTurnRequest,
  type ExternalAgentTurnResponse,
} from "@/lib/agent-engine/external/contracts";
import type { JobRow } from "@/lib/agent-engine/queue/queue";
import type { CapturedLeadFacts } from "@/lib/leads/ai-qualification";

type TransportMode = "accept" | "fail_before_accept";

const transport = vi.hoisted(() => ({
  mode: "accept" as TransportMode,
  calls: 0,
  acceptedExternalIds: [] as string[],
}));

const externalRuntimeTrace = vi.hoisted(() => ({
  flaskResponses: [] as Array<{
    requestSchemaVersion: string;
    requestRetryAttempt: number;
    responseSchemaVersion: string;
    status: string;
    hasCheckpoint: boolean;
  }>,
  generationOutcomes: [] as Array<{
    kind: string;
    reason: string | null;
    acceptedResponseSchemaVersion: string | null;
    correctionAttemptOccurred: boolean;
  }>,
}));

vi.mock("@/lib/agent-engine/external/generation", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/agent-engine/external/generation")>();
  return {
    ...original,
    executeExternalGeneration: async (
      args: Parameters<typeof original.executeExternalGeneration>[0],
    ) => {
      const flaskResponseCountBefore = externalRuntimeTrace.flaskResponses.length;
      const outcome = await original.executeExternalGeneration(args);
      externalRuntimeTrace.generationOutcomes.push({
        kind: outcome.kind,
        reason: "reason" in outcome ? outcome.reason : null,
        acceptedResponseSchemaVersion:
          outcome.kind === "reply_processed" && outcome.acceptedResponse !== undefined
            ? outcome.acceptedResponse.schema_version
            : null,
        correctionAttemptOccurred: externalRuntimeTrace.flaskResponses
          .slice(flaskResponseCountBefore)
          .some((response) => response.requestRetryAttempt === 2),
      });
      return outcome;
    },
  };
});

vi.mock("@/lib/channels", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/channels")>();
  const adapter: ChannelAdapter = {
    provider: "waha",
    resolveRecipient: ({ phoneNumber }) =>
      phoneNumber ? `${phoneNumber.replace(/\D/g, "")}@c.us` : null,
    isConfigured: () => true,
    codes: {
      notConfigured: "synthetic_not_configured",
      sendFailed: "synthetic_send_failed",
      unknownError: "synthetic_unknown_error",
    },
    send: async (envelope: OutboundEnvelope) => {
      transport.calls += 1;
      await envelope.beforeSend?.();
      if (transport.mode === "fail_before_accept") {
        throw new Error("synthetic_transport_failed_before_accept");
      }
      const externalId = `synthetic-accepted-${transport.calls}`;
      transport.acceptedExternalIds.push(externalId);
      return { externalId };
    },
  };
  return { ...original, getAdapter: () => adapter };
});

const REQUIRED_ENV = [
  "ZSAI_V2_TEST_DATABASE_URL",
  "ZSAI_V2_TEST_SUPABASE_URL",
  "ZSAI_V2_TEST_SUPABASE_SERVICE_ROLE_KEY",
  "ZSAI_V2_TEST_PROJECT_REF",
  "ZSAI_V2_TEST_INTERNAL_SECRET",
  "ZSAI_V2_TEST_SARVAM_API_KEY",
] as const;

interface HarnessConfig {
  databaseUrl: string;
  supabaseUrl: string;
  serviceRoleKey: string;
  projectRef: string;
  internalSecret: string;
  pythonUrl: string;
}

interface Fixture {
  organizationId: string;
  pipelineId: string;
  stageId: string;
  channelSessionId: string;
  agentId: string;
  agentVersionId: string;
  contactId: string;
  conversationId: string;
  leadId: string;
  inboundMessageId: string;
  job: JobRow;
}

interface Modules {
  createInboundTurnHandler: (typeof import("@/lib/agent-engine/agent/inbound-turn"))["createInboundTurnHandler"];
  crmEdgeConfigFromEnv: (typeof import("@/lib/agent-engine/edge/crm/mcp-client"))["crmEdgeConfigFromEnv"];
}

const CUSTOMER_FACTS =
  "My name is Ahmed. I run a digital marketing agency in Dubai. We get around 40 WhatsApp enquiries every day. " +
  "We have 5 sales staff. Most enquiries are in English and Malayalam. We need lead qualification, answers to FAQs, " +
  "and human handoff. How much does this cost? Can you arrange a demo?";

const EXPECTED_FACTS: CapturedLeadFacts = {
  explicit_name: { value: "Ahmed", evidence: "My name is Ahmed" },
  business_industry: "Digital Marketing Agency",
  location: "Dubai",
  enquiry_volume_per_day: 40,
  sales_team_size: 5,
  languages: ["English", "Malayalam"],
  needs: ["lead_qualification", "faq_answering", "human_handoff"],
  pricing_requested: true,
  demo_requested: true,
};

const runRequested = process.env.ZSAI_V2_TEST_RUN === "1";
const isolated = runRequested ? describe : describe.skip;

let config: HarnessConfig;
let pool: pg.Pool;
let poolOpened = false;
let modules: Modules;
let fixture: Fixture | null = null;
let fixtureOrganizationUnderConstruction: string | null = null;
let seededPlatformPlaybook: { pointerVersionId: string } | null = null;

function requiredExplicitEnv(): HarnessConfig {
  if (process.env.ZSAI_V2_TEST_ALLOW_DATABASE_MUTATION !== "isolated-v2-only") {
    throw new Error(
      "ZSAI_V2_TEST_ALLOW_DATABASE_MUTATION must equal isolated-v2-only before this harness may mutate a database",
    );
  }
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`missing explicit isolated test variables: ${missing.join(", ")}`);
  }
  const pythonUrl = process.env.ZSAI_V2_TEST_PYTHON_URL?.trim() || "http://127.0.0.1:5001";
  if (pythonUrl.replace(/\/$/, "") !== "http://127.0.0.1:5001") {
    throw new Error("ZSAI_V2_TEST_PYTHON_URL must be exactly http://127.0.0.1:5001");
  }
  return {
    databaseUrl: process.env.ZSAI_V2_TEST_DATABASE_URL!,
    supabaseUrl: process.env.ZSAI_V2_TEST_SUPABASE_URL!,
    serviceRoleKey: process.env.ZSAI_V2_TEST_SUPABASE_SERVICE_ROLE_KEY!,
    projectRef: process.env.ZSAI_V2_TEST_PROJECT_REF!,
    internalSecret: process.env.ZSAI_V2_TEST_INTERNAL_SECRET!,
    pythonUrl,
  };
}

function assertMatchingProjectIdentity(input: HarnessConfig): void {
  const ref = input.projectRef.trim();
  if (!/^[a-z0-9]{20}$/.test(ref)) throw new Error("invalid isolated Supabase project ref");

  const supabase = new URL(input.supabaseUrl);
  if (supabase.protocol !== "https:" || supabase.hostname !== `${ref}.supabase.co`) {
    throw new Error("isolated Supabase URL does not match ZSAI_V2_TEST_PROJECT_REF");
  }

  const database = new URL(input.databaseUrl);
  const databaseUser = decodeURIComponent(database.username);
  const directHostMatches = database.hostname === `db.${ref}.supabase.co`;
  const poolerUserMatches = databaseUser === `postgres.${ref}`;
  if (!directHostMatches && !poolerUserMatches) {
    throw new Error("isolated database URL does not match ZSAI_V2_TEST_PROJECT_REF");
  }
}

async function preflightDatabase(): Promise<void> {
  const { rows } = await pool.query<{
    database_name: string;
    current_user_name: string;
    public_tables: number;
    has_external_response: boolean;
    has_checkpoint_index: boolean;
  }>(
    `select current_database() as database_name,
            current_user as current_user_name,
            (select count(*)::int from information_schema.tables
              where table_schema='public' and table_type='BASE TABLE') as public_tables,
            exists (select 1 from information_schema.columns
                     where table_schema='public' and table_name='send_ledger'
                       and column_name='external_response') as has_external_response,
            to_regclass('public.uq_lead_checkpoints_org_job') is not null as has_checkpoint_index`,
  );
  const row = rows[0];
  if (!row || row.database_name !== "postgres" || row.current_user_name !== "postgres") {
    throw new Error("isolated database identity check failed");
  }
  if (row.public_tables < 100 || !row.has_external_response || !row.has_checkpoint_index) {
    throw new Error("isolated database is not the verified V2 baseline");
  }
}

async function ensurePlatformPlaybook(): Promise<void> {
  const existing = await pool.query<{ version_id: string }>(
    "select version_id from playbook_pointers where organization_id is null and layer='platform'",
  );
  if (existing.rows[0]) return;
  const inserted = await pool.query<{ id: string }>(
    `insert into playbook_versions (organization_id, layer, content)
     values (null, 'platform', $1) returning id`,
    [
      "## Customer support\nReply naturally in the language of the customer's latest message. " +
        "Never expose implementation details or internal workflow vocabulary.",
    ],
  );
  const versionId = inserted.rows[0]!.id;
  await pool.query(
    "insert into playbook_pointers (organization_id, layer, version_id) values (null, 'platform', $1)",
    [versionId],
  );
  seededPlatformPlaybook = { pointerVersionId: versionId };
}

async function createFixture(label: string): Promise<Fixture> {
  const ids: {
    organizationId: string;
    pipelineId: string;
    stageId: string;
    channelSessionId: string;
    agentId: string;
    agentVersionId: string;
    contactId: string;
    conversationId: string;
    leadId: string;
    inboundMessageId: string;
    eventId: string;
    jobId: string;
  } = {
    organizationId: randomUUID(),
    pipelineId: randomUUID(),
    stageId: randomUUID(),
    channelSessionId: randomUUID(),
    agentId: randomUUID(),
    agentVersionId: randomUUID(),
    contactId: randomUUID(),
    conversationId: randomUUID(),
    leadId: randomUUID(),
    inboundMessageId: randomUUID(),
    eventId: randomUUID(),
    jobId: randomUUID(),
  };
  fixtureOrganizationUnderConstruction = ids.organizationId;
  const slug = `zsai-v2-${label}-${ids.organizationId.slice(0, 8)}`;

  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name, timezone, locale, settings)
     values ($1, $2, 'ZSAI V2 Isolated Test', 'ZSAI V2 Isolated Test', 'Asia/Dubai', 'en-US', '{}'::jsonb)`,
    [ids.organizationId, slug],
  );

  const defaultPipeline = await pool.query<{ id: string }>(
    "select id from crm_pipelines where organization_id=$1 and is_default=true order by created_at limit 1",
    [ids.organizationId],
  );
  if (defaultPipeline.rows[0]) {
    ids.pipelineId = defaultPipeline.rows[0].id;
  } else {
    await pool.query(
      `insert into crm_pipelines (id, organization_id, name, slug, is_default)
       values ($1, $2, 'Isolated V2 Pipeline', 'isolated_v2', true)`,
      [ids.pipelineId, ids.organizationId],
    );
  }

  const firstStage = await pool.query<{ id: string }>(
    "select id from crm_stages where organization_id=$1 and pipeline_id=$2 order by position limit 1",
    [ids.organizationId, ids.pipelineId],
  );
  if (firstStage.rows[0]) {
    ids.stageId = firstStage.rows[0].id;
  } else {
    await pool.query(
      `insert into crm_stages (id, organization_id, pipeline_id, name, slug, position)
       values ($1, $2, $3, 'New', 'new', 1000)`,
      [ids.stageId, ids.organizationId, ids.pipelineId],
    );
  }

  await pool.query(
    `insert into channel_sessions
       (id, organization_id, provider, waha_session_name, status, webhook_secret_encrypted,
        metadata, daily_message_limit, warmup_completed_at)
     values ($1, $2, 'waha', $3, 'WORKING', decode('00','hex'), '{}'::jsonb, 1000,
             now() - interval '40 days')`,
    [ids.channelSessionId, ids.organizationId, `zsai-v2-${label}`],
  );
  await pool.query(
    `insert into ai_agents
       (id, organization_id, name, is_active, is_default, model, system_prompt, kind)
     values ($1, $2, 'ZSAI V2 Test Anchor', true, true, 'legacy/test-anchor', $3, 'mcp_agent')`,
    [
      ids.agentId,
      ids.organizationId,
      "You are a concise customer-facing sales assistant. Answer the customer's question safely. " +
        "Do not invent prices or book a demo; acknowledge those requests for human follow-up.",
    ],
  );
  await pool.query(
    `insert into ai_agent_versions
       (id, organization_id, agent_id, version_number, system_prompt, provider, model,
        channel_session_id, status, published_at, max_steps)
     values ($1, $2, $3, 1, $4, 'groq', 'legacy/test-anchor', $5, 'published', now(), 4)`,
    [
      ids.agentVersionId,
      ids.organizationId,
      ids.agentId,
      "Reply in the customer's current language and keep all wording customer-safe.",
      ids.channelSessionId,
    ],
  );
  await pool.query(
    "update ai_agents set published_version_id=$1 where organization_id=$2 and id=$3",
    [ids.agentVersionId, ids.organizationId, ids.agentId],
  );
  await pool.query(
    `insert into contacts (id, organization_id, name, display_name, phone_number, source)
     values ($1, $2, null, 'Abi Zakariya', '+971501234567', 'manual')`,
    [ids.contactId, ids.organizationId],
  );
  await pool.query(
    `insert into conversations
       (id, organization_id, contact_id, channel_session_id, channel, status, is_group,
        last_inbound_at, last_message_at)
     values ($1, $2, $3, $4, 'whatsapp', 'open', false, now(), now())`,
    [ids.conversationId, ids.organizationId, ids.contactId, ids.channelSessionId],
  );
  await pool.query(
    `insert into crm_leads
       (id, organization_id, pipeline_id, stage_id, contact_id, title, status, source)
     values ($1, $2, $3, $4, $5, 'Synthetic Ahmed lead', 'open', 'manual')`,
    [ids.leadId, ids.organizationId, ids.pipelineId, ids.stageId, ids.contactId],
  );
  await pool.query(
    `insert into messages
       (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction,
        status, body, sent_via, sent_at)
     values ($1, $2, $3, $4, $5, 'text', 'inbound', 'received', $6, 'external_device', now())`,
    [
      ids.inboundMessageId,
      ids.organizationId,
      ids.conversationId,
      ids.channelSessionId,
      ids.contactId,
      CUSTOMER_FACTS,
    ],
  );
  const jobResult = await pool.query<JobRow>(
    `insert into job_queue
       (id, organization_id, contact_id, kind, payload, status, attempts, max_attempts, locked_by, locked_at)
     values ($1, $2, $3, 'inbound_turn', $4, 'running', 1, 5, 'zsai-v2-isolated', now())
     returning *`,
    [
      ids.jobId,
      ids.organizationId,
      ids.contactId,
      JSON.stringify({
        conversation_id: ids.conversationId,
        contact_id: ids.contactId,
        channel_session_id: ids.channelSessionId,
        inbound_message_id: ids.inboundMessageId,
        crm_event_id: ids.eventId,
      }),
    ],
  );

  fixtureOrganizationUnderConstruction = null;
  return { ...ids, job: jobResult.rows[0]! };
}

function responseFor(
  request: ExternalAgentTurnRequest,
  marker: "A" | "B",
  reply: string,
  facts: CapturedLeadFacts,
) {
  return {
    schema_version: "2" as const,
    request_id: request.request_id,
    trace_id: `synthetic-trace-${marker}`,
    status: "reply" as const,
    actions: [],
    reply: { type: "text" as const, text: reply },
    checkpoint: {
      commitments: [],
      objections: [],
      next_action: "Human follow-up for pricing and demo",
      rolling_summary: `accepted-candidate-${marker}`,
      captured_facts: facts,
    },
    handoff: null,
    usage: {
      provider: "synthetic-test-only",
      model: "synthetic-v2",
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
    },
  };
}

function handler(
  call?: (request: ExternalAgentTurnRequest) => Promise<ExternalAgentTurnResponse>,
) {
  return modules.createInboundTurnHandler({
    crmCfg: modules.crmEdgeConfigFromEnv({
      SUPABASE_URL: config.supabaseUrl,
      SUPABASE_SERVICE_ROLE_KEY: config.serviceRoleKey,
    }),
    llmCfg: {},
    knobs: {
      historyLimit: 20,
      maxContextTokens: 8_000,
      notesIndexMaxTokens: 500,
      maxSteps: 4,
      maxSendsPerTurn: 1,
      queuedRetryDelayMs: 1_000,
      breaker: {
        exactFailureWarn: 2,
        exactFailureBlock: 5,
        sameToolFailureWarn: 3,
        sameToolFailureHalt: 8,
        noProgressWarn: 3,
        noProgressBlock: 5,
      },
      disclosureMode: "inject",
      promiseSemantic: { enabled: false },
      allowlistTtlMs: 21 * 24 * 60 * 60 * 1_000,
    },
    externalAgent: {
      runtime: "python",
      baseUrl: config.pythonUrl,
      secret: config.internalSecret,
      timeoutMs: 90_000,
      ...(call ? { call } : {}),
    },
    clock: () => new Date("2026-10-01T14:00:00.000Z"),
    sleep: async () => undefined,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  });
}

function externalResponseTrace(value: unknown): {
  present: boolean;
  schemaVersion: string | null;
  status: string | null;
  hasCheckpoint: boolean;
} {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { present: false, schemaVersion: null, status: null, hasCheckpoint: false };
  }
  const response = value as Record<string, unknown>;
  return {
    present: true,
    schemaVersion: typeof response.schema_version === "string" ? response.schema_version : null,
    status: typeof response.status === "string" ? response.status : null,
    hasCheckpoint: "checkpoint" in response,
  };
}

async function persistedState(current: Fixture) {
  const [messages, ledger, checkpoints, contact, leads] = await Promise.all([
    pool.query<{ id: string; status: string; body: string | null }>(
      "select id,status,body from messages where organization_id=$1 and conversation_id=$2 and direction='outbound' order by created_at,id",
      [current.organizationId, current.conversationId],
    ),
    pool.query<{ status: string; external_response: unknown; crm_message_id: string | null }>(
      "select status,external_response,crm_message_id from send_ledger where organization_id=$1 and job_id=$2 order by seq",
      [current.organizationId, current.job.id],
    ),
    pool.query<{ rolling_summary: string }>(
      "select rolling_summary from lead_checkpoints where organization_id=$1 and job_id=$2",
      [current.organizationId, current.job.id],
    ),
    pool.query<{ name: string | null; display_name: string | null }>(
      "select name,display_name from contacts where organization_id=$1 and id=$2",
      [current.organizationId, current.contactId],
    ),
    pool.query<{ id: string; custom_fields: Record<string, unknown> }>(
      "select id,custom_fields from crm_leads where organization_id=$1 and contact_id=$2",
      [current.organizationId, current.contactId],
    ),
  ]);
  return {
    messages: messages.rows,
    ledger: ledger.rows,
    checkpoints: checkpoints.rows,
    contact: contact.rows[0],
    leads: leads.rows,
  };
}

function assertQualification(
  state: Awaited<ReturnType<typeof persistedState>>,
  leadId: string,
): void {
  expect(state.contact).toEqual({ name: "Ahmed", display_name: "Abi Zakariya" });
  expect(state.leads).toHaveLength(1);
  expect(state.leads[0]!.id).toBe(leadId);
  const qualification = state.leads[0]!.custom_fields.ai_qualification as Record<string, unknown>;
  expect(String(qualification.business_industry).toLowerCase()).toContain("digital marketing");
  expect(String(qualification.location).toLowerCase()).toBe("dubai");
  expect(qualification.enquiry_volume_per_day).toBe(40);
  expect(qualification.sales_team_size).toBe(5);
  expect((qualification.languages as string[]).map((value) => value.toLowerCase())).toEqual(
    expect.arrayContaining(["english", "malayalam"]),
  );
  expect(qualification.needs).toEqual(
    expect.arrayContaining(["lead_qualification", "faq_answering", "human_handoff"]),
  );
  expect(qualification.pricing_requested).toBe(true);
  expect(qualification.demo_requested).toBe(true);
}

beforeAll(async () => {
  if (!runRequested) return;
  config = requiredExplicitEnv();
  assertMatchingProjectIdentity(config);

  // Explicit test values are installed before any application module import.
  // The dedicated Vitest config has no setup file and an empty envDir.
  process.env.NEXT_PUBLIC_SUPABASE_URL = config.supabaseUrl;
  process.env.SUPABASE_SERVICE_ROLE_KEY = config.serviceRoleKey;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "isolated-harness-unused";

  pool = new pg.Pool({
    connectionString: config.databaseUrl,
    ssl: { rejectUnauthorized: false },
    max: 2,
  });
  poolOpened = true;
  await preflightDatabase();
  await ensurePlatformPlaybook();

  modules = {
    createInboundTurnHandler: (await import("@/lib/agent-engine/agent/inbound-turn"))
      .createInboundTurnHandler,
    crmEdgeConfigFromEnv: (await import("@/lib/agent-engine/edge/crm/mcp-client"))
      .crmEdgeConfigFromEnv,
  };
});

beforeEach(() => {
  transport.mode = "accept";
  transport.calls = 0;
  transport.acceptedExternalIds.length = 0;
  externalRuntimeTrace.flaskResponses.length = 0;
  externalRuntimeTrace.generationOutcomes.length = 0;
});

afterEach(async () => {
  if (!runRequested || !poolOpened) return;
  const organizationId = fixture?.organizationId ?? fixtureOrganizationUnderConstruction;
  if (organizationId) await pool.query("delete from organizations where id=$1", [organizationId]);
  fixture = null;
  fixtureOrganizationUnderConstruction = null;
});

afterAll(async () => {
  if (!runRequested || !poolOpened) return;
  if (fixture) await pool.query("delete from organizations where id=$1", [fixture.organizationId]);
  if (fixtureOrganizationUnderConstruction) {
    await pool.query("delete from organizations where id=$1", [
      fixtureOrganizationUnderConstruction,
    ]);
  }
  if (seededPlatformPlaybook) {
    await pool.query(
      "delete from playbook_pointers where organization_id is null and layer='platform' and version_id=$1",
      [seededPlatformPlaybook.pointerVersionId],
    );
    await pool.query("delete from playbook_versions where id=$1", [
      seededPlatformPlaybook.pointerVersionId,
    ]);
  }
  await pool.end();
});

isolated("external runtime V2 — isolated Supabase and mocked provider transport", () => {
  it("persists a deterministic V2 response through the canonical CRM path", async () => {
    fixture = await createFixture("normal");
    const externalCall = vi.fn(async (request: ExternalAgentTurnRequest) =>
      externalAgentTurnResponseSchema.parse(
        responseFor(
          request,
          "B",
          "Thanks, Ahmed. I've noted your business details and requirements.",
          EXPECTED_FACTS,
        ),
      ),
    );

    await handler(externalCall)(fixture.job, pool, { workerId: "zsai-v2-isolated" });

    const state = await persistedState(fixture);
    expect(externalCall).toHaveBeenCalledTimes(1);
    expect(externalCall).toHaveBeenCalledWith(
      expect.objectContaining({
        schema_version: "2",
        retry: expect.objectContaining({ attempt: 1 }),
      }),
      expect.any(Object),
    );
    expect(transport.acceptedExternalIds).toHaveLength(1);
    expect(state.messages.filter((message) => message.status === "sent")).toHaveLength(1);
    expect(state.ledger).toHaveLength(1);
    expect(state.ledger[0]).toMatchObject({ status: "accepted" });
    expect(externalRuntimeTrace.generationOutcomes.at(-1)).toMatchObject({
      kind: "reply_processed",
      acceptedResponseSchemaVersion: "2",
    });
    expect(externalResponseTrace(state.ledger[0]!.external_response)).toEqual({
      present: true,
      schemaVersion: "2",
      status: "reply",
      hasCheckpoint: true,
    });
    expect(state.checkpoints).toHaveLength(1);
    const externalResponse = state.ledger[0]!.external_response as {
      schema_version: string;
      usage?: { provider?: string; model?: string };
    };
    expect(externalResponse.schema_version).toBe("2");
    expect(externalResponse.usage?.provider).toBe("synthetic-test-only");
    expect(externalResponse.usage?.model).toBe("synthetic-v2");
    assertQualification(state, fixture.leadId);
  });

  it("rebinds a proven-unsent failed candidate and persists only candidate B", async () => {
    fixture = await createFixture("replaceable");
    let generation = 0;
    const externalCall = vi.fn(async (request: ExternalAgentTurnRequest) => {
      generation += 1;
      return generation === 1
        ? responseFor(request, "A", "Thanks. A colleague can follow up about your request.", {
            ...EXPECTED_FACTS,
            explicit_name: null,
            location: "Candidate A",
          })
        : responseFor(
            request,
            "B",
            "Thanks, Ahmed. A colleague can follow up about pricing and a demo.",
            EXPECTED_FACTS,
          );
    });
    const run = handler(externalCall);

    transport.mode = "fail_before_accept";
    await expect(run(fixture.job, pool, { workerId: "zsai-v2-isolated" })).rejects.toThrow(
      /envio marcado como failed/,
    );
    let state = await persistedState(fixture);
    expect(state.ledger[0]).toMatchObject({ status: "failed" });
    expect(state.checkpoints).toHaveLength(0);
    expect(transport.acceptedExternalIds).toHaveLength(0);

    transport.mode = "accept";
    await run(fixture.job, pool, { workerId: "zsai-v2-isolated" });

    state = await persistedState(fixture);
    expect(externalCall).toHaveBeenCalledTimes(2);
    expect(transport.acceptedExternalIds).toHaveLength(1);
    expect(state.messages.filter((message) => message.status === "sent")).toHaveLength(1);
    expect(state.ledger).toHaveLength(1);
    expect(state.ledger[0]).toMatchObject({ status: "accepted" });
    expect(
      (state.ledger[0]!.external_response as { checkpoint: { rolling_summary: string } }).checkpoint
        .rolling_summary,
    ).toBe("accepted-candidate-B");
    expect(state.checkpoints).toEqual([{ rolling_summary: "accepted-candidate-B" }]);
    expect(JSON.stringify(state.ledger[0]!.external_response)).not.toContain("Candidate A");
    assertQualification(state, fixture.leadId);
  });

  it("holds an ambiguous requested delivery without regeneration, resend, or metadata replacement", async () => {
    fixture = await createFixture("ambiguous");
    const candidateA = responseFor(
      {
        schema_version: "2",
        request_id: randomUUID(),
      } as ExternalAgentTurnRequest,
      "A",
      "Thanks. A colleague can follow up.",
      { ...EXPECTED_FACTS, location: "Candidate A" },
    );
    const ledgerId = randomUUID();
    await pool.query(
      `insert into send_ledger
         (id, organization_id, contact_id, job_id, seq, body_hash, status, external_response)
       values ($1, $2, $3, $4, 1, repeat('0',64), 'requested', $5)`,
      [
        ledgerId,
        fixture.organizationId,
        fixture.contactId,
        fixture.job.id,
        JSON.stringify(candidateA),
      ],
    );
    await pool.query(
      `insert into messages
         (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction,
          status, body, sent_via, sent_at, metadata)
       values ($1, $2, $3, $4, $5, 'text', 'outbound', 'sending', $6, 'ai', now(), $7)`,
      [
        ledgerId,
        fixture.organizationId,
        fixture.conversationId,
        fixture.channelSessionId,
        fixture.contactId,
        candidateA.reply.text,
        JSON.stringify({ idempotency_key: ledgerId }),
      ],
    );
    const externalCall = vi.fn(async (request: ExternalAgentTurnRequest) =>
      responseFor(
        request,
        "B",
        "This response must never be generated while delivery A is ambiguous.",
        EXPECTED_FACTS,
      ),
    );

    await expect(
      handler(externalCall)(fixture.job, pool, { workerId: "zsai-v2-isolated" }),
    ).rejects.toThrow("external_response_delivery_pending");

    const state = await persistedState(fixture);
    expect(externalCall).not.toHaveBeenCalled();
    expect(transport.calls).toBe(0);
    expect(transport.acceptedExternalIds).toHaveLength(0);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.status).toBe("sending");
    expect(state.ledger).toHaveLength(1);
    expect(state.ledger[0]).toMatchObject({ status: "requested", crm_message_id: null });
    expect(
      (state.ledger[0]!.external_response as { checkpoint: { rolling_summary: string } }).checkpoint
        .rolling_summary,
    ).toBe("accepted-candidate-A");
    expect(state.checkpoints).toHaveLength(0);
    expect(state.contact).toEqual({ name: null, display_name: "Abi Zakariya" });
  });
});
