import { z } from "zod";
import {
  AssessmentSchema,
  ChunkSchema,
  ClassifierPolicySchema,
  ExecutionPolicySchema,
  MemoryPatchSchema,
  MemorySchema,
  RelevanceResultSchema,
  SemanticComparisonSchema,
  TaskContextSchema,
} from "../schema";

export type StubResponse<T> = {
  output?: T | undefined;
  error?: string | undefined;
  delayMs?: number | undefined;
};

const response = <T extends z.ZodType>(schema: T) =>
  z
    .object({
      output: schema.optional(),
      error: z.string().optional(),
      delayMs: z.number().int().nonnegative().optional(),
    })
    .strict()
    .refine(
      (value) => (value.output === undefined) !== (value.error === undefined),
      {
        message: "a stub response must contain exactly one of output or error",
      },
    );

export const DeterministicFixtureSchema = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    initialMemory: MemorySchema,
    chunk: ChunkSchema,
    taskContext: TaskContextSchema,
    classifierPolicy: ClassifierPolicySchema,
    executionPolicy: ExecutionPolicySchema,
    auditDeadlineMs: z.number().int().positive().optional(),
    stubs: z
      .object({
        relevance: z.array(response(RelevanceResultSchema)).default([]),
        assessments: z.array(response(AssessmentSchema)).default([]),
        proposals: z.array(response(MemoryPatchSchema)).default([]),
        compressions: z.array(response(MemoryPatchSchema)).default([]),
        comparisons: z.array(response(SemanticComparisonSchema)).default([]),
      })
      .strict(),
    expected: z
      .object({
        status: z.enum([
          "committed",
          "no_update",
          "replayed",
          "retained",
          "budget_exceeded",
          "escalated",
        ]),
        revision: z.number().int().nonnegative().optional(),
        auditSampled: z.boolean().optional(),
        auditOutcome: z
          .enum(["not_sampled", "empty_patch", "patch", "failed", "timed_out"])
          .optional(),
        reasonIncludes: z.string().optional(),
      })
      .strict(),
  })
  .strict();

export type DeterministicFixture = z.infer<typeof DeterministicFixtureSchema>;
