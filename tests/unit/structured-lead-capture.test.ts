import { beforeEach, describe, expect, it, vi } from "vitest";

const patchContactHandler = vi.fn();
const getLeadHandler = vi.fn();
const updateLeadHandler = vi.fn();

vi.mock("@/app/api/v1/contacts/_handler", () => ({
  patchContactHandler: (...args: unknown[]) => patchContactHandler(...args),
}));
vi.mock("@/app/api/v1/leads/_handler", () => ({
  getLeadHandler: (...args: unknown[]) => getLeadHandler(...args),
  updateLeadHandler: (...args: unknown[]) => updateLeadHandler(...args),
}));

import { capturedLeadFactsSchema, mergeAiQualification } from "@/lib/leads/ai-qualification";
import {
  persistStructuredLeadCapture,
  verifiedSelfReportedName,
} from "@/lib/agent-engine/agent/structured-lead-capture";

const ORGANIZATION_ID = "10000000-0000-4000-8000-000000000001";
const CONTACT_ID = "20000000-0000-4000-8000-000000000002";
const LEAD_ID = "30000000-0000-4000-8000-000000000003";
const JOB_ID = "40000000-0000-4000-8000-000000000004";

function facts(input: Record<string, unknown>) {
  return capturedLeadFactsSchema.parse(input);
}

describe("captura estruturada do lead", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getLeadHandler.mockResolvedValue({ id: LEAD_ID, custom_fields: { origem: "WhatsApp" } });
    updateLeadHandler.mockResolvedValue({ id: LEAD_ID });
    patchContactHandler.mockResolvedValue({
      id: CONTACT_ID,
      name: "Ahmed",
      display_name: "Abi Zakariya",
    });
  });

  it("checkpoint antigo sem captured_facts degrada para captura vazia", () => {
    expect(capturedLeadFactsSchema.parse(undefined)).toEqual({
      explicit_name: null,
      business_industry: null,
      location: null,
      enquiry_volume_per_day: null,
      sales_team_size: null,
      languages: [],
      needs: [],
      pricing_requested: false,
      demo_requested: false,
    });
  });

  it("aceita nome somente quando há autodeclaração literal na mensagem do cliente", () => {
    const explicitName = { value: "Ahmed", evidence: "My name is Ahmed" };
    expect(
      verifiedSelfReportedName(explicitName, ["My name is Ahmed. We have 5 sales staff."]),
    ).toBe("Ahmed");
    expect(verifiedSelfReportedName(explicitName, ["Please call Ahmed tomorrow"])).toBeNull();
  });

  it("mescla turnos sem duplicar listas nem apagar fatos anteriores", () => {
    const first = mergeAiQualification(
      {},
      facts({
        business_industry: "Digital Marketing Agency",
        location: "Dubai",
        enquiry_volume_per_day: 40,
        needs: ["lead_qualification", "faq_answering"],
      }),
    );
    const second = mergeAiQualification(
      first,
      facts({
        sales_team_size: 5,
        languages: ["English", "Malayalam", "english"],
        needs: ["human_handoff", "lead_qualification"],
        pricing_requested: true,
        demo_requested: true,
      }),
    );

    expect(second).toEqual({
      business_industry: "Digital Marketing Agency",
      location: "Dubai",
      enquiry_volume_per_day: 40,
      sales_team_size: 5,
      languages: ["English", "Malayalam"],
      needs: ["lead_qualification", "faq_answering", "human_handoff"],
      pricing_requested: true,
      demo_requested: true,
    });
  });

  it("persiste fatos no lead e atualiza só o nome canônico, preservando o display do WhatsApp", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("from crm_leads")) {
        return {
          rows: [
            {
              id: LEAD_ID,
              organization_id: ORGANIZATION_ID,
              pipeline_id: "50000000-0000-4000-8000-000000000005",
              status: "open",
              last_activity_at: null,
              created_at: "2026-09-29T00:00:00.000Z",
            },
          ],
        };
      }
      return { rows: [{ id: "50000000-0000-4000-8000-000000000005" }] };
    });
    const contactQuery = {
      select: vi.fn(),
      eq: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValue({ data: { name: null }, error: null }),
    };
    contactQuery.select.mockReturnValue(contactQuery);
    contactQuery.eq.mockReturnValue(contactQuery);
    const supabase = { from: vi.fn().mockReturnValue(contactQuery) };

    await persistStructuredLeadCapture({
      pool: { query } as never,
      supabase: supabase as never,
      organizationId: ORGANIZATION_ID,
      contactId: CONTACT_ID,
      jobId: JOB_ID,
      agentId: null,
      customerMessages: ["My name is Ahmed. We have 5 sales staff."],
      facts: facts({
        explicit_name: { value: "Ahmed", evidence: "My name is Ahmed" },
        sales_team_size: 5,
        languages: ["English", "Malayalam"],
        pricing_requested: true,
        demo_requested: true,
      }),
    });

    expect(patchContactHandler).toHaveBeenCalledOnce();
    expect(patchContactHandler.mock.calls[0]?.[3]).toEqual({ name: "Ahmed" });
    expect(patchContactHandler.mock.calls[0]?.[3]).not.toHaveProperty("display_name");
    expect(updateLeadHandler.mock.calls[0]?.[3]).toEqual({
      custom_fields: {
        ai_qualification: {
          sales_team_size: 5,
          languages: ["English", "Malayalam"],
          pricing_requested: true,
          demo_requested: true,
        },
      },
    });
  });
});
