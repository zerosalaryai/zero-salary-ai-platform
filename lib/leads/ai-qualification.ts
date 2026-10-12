import { z } from "zod";

export const AI_QUALIFICATION_FIELD = "ai_qualification";

const shortFact = z.string().trim().min(1).max(200);

export const capturedLeadFactsSchema = z
  .object({
    explicit_name: z
      .object({
        value: z.string().trim().min(2).max(120),
        evidence: z.string().trim().min(3).max(240),
      })
      .nullable()
      .default(null),
    business_industry: shortFact.nullable().default(null),
    location: shortFact.nullable().default(null),
    enquiry_volume_per_day: z.number().int().nonnegative().max(1_000_000).nullable().default(null),
    sales_team_size: z.number().int().nonnegative().max(1_000_000).nullable().default(null),
    languages: z.array(shortFact).max(20).default([]),
    needs: z
      .array(z.enum(["lead_qualification", "faq_answering", "human_handoff"]))
      .max(3)
      .default([]),
    pricing_requested: z.boolean().default(false),
    demo_requested: z.boolean().default(false),
  })
  .default(() => ({
    explicit_name: null,
    business_industry: null,
    location: null,
    enquiry_volume_per_day: null,
    sales_team_size: null,
    languages: [],
    needs: [],
    pricing_requested: false,
    demo_requested: false,
  }));

export type CapturedLeadFacts = z.infer<typeof capturedLeadFactsSchema>;

export interface AiQualificationProfile {
  business_industry?: string;
  location?: string;
  enquiry_volume_per_day?: number;
  sales_team_size?: number;
  languages?: string[];
  needs?: Array<"lead_qualification" | "faq_answering" | "human_handoff">;
  pricing_requested?: true;
  demo_requested?: true;
}

export const qualificationProfileSchema = z
  .object({
    business_industry: shortFact.optional(),
    location: shortFact.optional(),
    enquiry_volume_per_day: z.number().int().nonnegative().max(1_000_000).optional(),
    sales_team_size: z.number().int().nonnegative().max(1_000_000).optional(),
    languages: z.array(shortFact).max(20).optional(),
    needs: z
      .array(z.enum(["lead_qualification", "faq_answering", "human_handoff"]))
      .max(3)
      .optional(),
    pricing_requested: z.literal(true).optional(),
    demo_requested: z.literal(true).optional(),
  })
  .strip();

function normalized(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function uniqueCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = normalized(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Merge determinístico: fatos escalares novos substituem os antigos; listas acumulam. */
export function mergeAiQualification(
  current: unknown,
  facts: CapturedLeadFacts,
): AiQualificationProfile {
  const parsed = qualificationProfileSchema.safeParse(current);
  const previous: AiQualificationProfile = parsed.success ? parsed.data : {};
  const next: AiQualificationProfile = { ...previous };

  if (facts.business_industry !== null) next.business_industry = facts.business_industry;
  if (facts.location !== null) next.location = facts.location;
  if (facts.enquiry_volume_per_day !== null) {
    next.enquiry_volume_per_day = facts.enquiry_volume_per_day;
  }
  if (facts.sales_team_size !== null) next.sales_team_size = facts.sales_team_size;
  if (facts.languages.length > 0) {
    next.languages = uniqueCaseInsensitive([...(previous.languages ?? []), ...facts.languages]);
  }
  if (facts.needs.length > 0) {
    next.needs = [...new Set([...(previous.needs ?? []), ...facts.needs])];
  }
  if (facts.pricing_requested || previous.pricing_requested) next.pricing_requested = true;
  if (facts.demo_requested || previous.demo_requested) next.demo_requested = true;

  return next;
}

export function hasQualificationFacts(facts: CapturedLeadFacts): boolean {
  return (
    facts.business_industry !== null ||
    facts.location !== null ||
    facts.enquiry_volume_per_day !== null ||
    facts.sales_team_size !== null ||
    facts.languages.length > 0 ||
    facts.needs.length > 0 ||
    facts.pricing_requested ||
    facts.demo_requested
  );
}
