import { z } from "zod";
import { ChunkSchema } from "./chunk";
import { MemorySchema, SourceRefSchema } from "./memory";
import { TaskContextSchema } from "./task";

/** Spec §5 semantic comparison: material before/after assessment. */
export const SemanticComparisonSchema = z
  .object({
    verdict: z.enum(["equivalent", "material_change", "uncertain"]),
    changes: z.array(
      z
        .object({
          kind: z.enum(["addition", "correction", "omission", "contradiction"]),
          before: z.string().nullable(),
          after: z.string().nullable(),
          sources: z.array(SourceRefSchema),
          assessment: z.enum([
            "required_update",
            "writer_regression",
            "uncertain",
          ]),
          reason: z.string(),
        })
        .strict(),
    ),
  })
  .strict();
export type SemanticComparison = z.infer<typeof SemanticComparisonSchema>;

export const SemanticComparisonInputSchema = z
  .object({
    before: MemorySchema,
    after: MemorySchema,
    chunk: ChunkSchema,
    taskContext: TaskContextSchema,
  })
  .strict();
export type SemanticComparisonInput = z.infer<
  typeof SemanticComparisonInputSchema
>;

export interface Evaluator {
  compare(input: SemanticComparisonInput): Promise<SemanticComparison>;
}
