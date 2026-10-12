import { z } from "zod";

import { capturedLeadFactsSchema } from "@/lib/leads/ai-qualification";
import { declaracaoDoTurnoSchema } from "./declaracao";

/** Campos que podem viajar junto da resposta do runtime externo. */
export const checkpointCoreSchema = z.object({
  commitments: z.array(z.string()).default([]),
  objections: z.array(z.string()).default([]),
  next_action: z.string().nullable().default(null),
  rolling_summary: z.string().default(""),
  captured_facts: capturedLeadFactsSchema,
});

/** Conteúdo persistido pelo fechamento nativo; a declaração segue exclusiva dele. */
export const checkpointContentSchema = checkpointCoreSchema.extend({
  declaracao: declaracaoDoTurnoSchema.optional(),
});

export type CheckpointCore = z.infer<typeof checkpointCoreSchema>;
export type CheckpointContent = z.infer<typeof checkpointContentSchema>;
