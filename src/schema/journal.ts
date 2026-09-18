import { z } from "zod";
import { AssessmentSchema, RelevanceResultSchema } from "./classifier";
import { SemanticComparisonSchema } from "./evaluation";
import { ChunkIdSchema, JournalEntryIdSchema } from "./ids";
import { MemorySchema, TopicSchema } from "./memory";
import { ExecutionPolicySchema } from "./policy";
import { MemoryPatchSchema } from "./writer";

export const ModelIdentifierSchema = z
  .object({
    provider: z.string(),
    model: z.string(),
    promptVersion: z.string(),
  })
  .strict();
export type ModelIdentifier = z.infer<typeof ModelIdentifierSchema>;

export const UsageSchema = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  })
  .strict();
export type Usage = z.infer<typeof UsageSchema>;

const JournalBaseSchema = z.object({
  id: JournalEntryIdSchema,
  occurredAt: z.string().datetime(),
  chunkId: ChunkIdSchema,
  snapshotRevision: z.number().int().nonnegative(),
});

const ClassifierTraceSchema = z
  .object({
    relevance: RelevanceResultSchema.optional(),
    assessment: AssessmentSchema.optional(),
    model: ModelIdentifierSchema.optional(),
    usage: UsageSchema.optional(),
    latencyMs: z.number().nonnegative().optional(),
  })
  .strict();

/** Spec §§4–5: an atomic live-memory change with enough history to recover topics. */
export const CommittedUpdateJournalEntrySchema = JournalBaseSchema.extend({
  type: z.literal("committed_update"),
  previousRevision: z.number().int().nonnegative(),
  newRevision: z.number().int().positive(),
  classifier: ClassifierTraceSchema.optional(),
  writerModel: ModelIdentifierSchema,
  proposedPatch: MemoryPatchSchema,
  writerUsage: UsageSchema,
  writerLatencyMs: z.number().nonnegative(),
  previousTopics: z.array(TopicSchema),
}).strict();
export type CommittedUpdateJournalEntry = z.infer<
  typeof CommittedUpdateJournalEntrySchema
>;

/** Spec §5 Step E: a committed bypass decision with no memory mutation. */
export const NoUpdateJournalEntrySchema = JournalBaseSchema.extend({
  type: z.literal("no_update"),
  previousRevision: z.number().int().nonnegative(),
  newRevision: z.number().int().nonnegative(),
  classifier: ClassifierTraceSchema,
  reason: z.string(),
}).strict();
export type NoUpdateJournalEntry = z.infer<typeof NoUpdateJournalEntrySchema>;

/** Spec §5 active audits: evaluation-only writer output, never a commit. */
export const AuditRecordJournalEntrySchema = JournalBaseSchema.extend({
  type: z.literal("audit_record"),
  policy: ExecutionPolicySchema,
  sampled: z.boolean(),
  proposedBypass: z.boolean(),
  outcome: z.enum([
    "not_sampled",
    "empty_patch",
    "patch",
    "failed",
    "timed_out",
  ]),
  patch: MemoryPatchSchema.optional(),
  writerModel: ModelIdentifierSchema.optional(),
  writerUsage: UsageSchema.optional(),
  writerLatencyMs: z.number().nonnegative().optional(),
}).strict();
export type AuditRecordJournalEntry = z.infer<
  typeof AuditRecordJournalEntrySchema
>;

/** Spec §5 semantic comparison: evaluation record kept apart from live commits. */
export const SemanticComparisonJournalEntrySchema = JournalBaseSchema.extend({
  type: z.literal("semantic_comparison"),
  comparison: SemanticComparisonSchema,
  evaluatorModel: ModelIdentifierSchema,
  evaluatorUsage: UsageSchema,
  evaluatorLatencyMs: z.number().nonnegative(),
}).strict();
export type SemanticComparisonJournalEntry = z.infer<
  typeof SemanticComparisonJournalEntrySchema
>;

export const JournalEntrySchema = z.discriminatedUnion("type", [
  CommittedUpdateJournalEntrySchema,
  NoUpdateJournalEntrySchema,
  AuditRecordJournalEntrySchema,
  SemanticComparisonJournalEntrySchema,
]);
export type JournalEntry = z.infer<typeof JournalEntrySchema>;

export const EvaluationJournalEntrySchema = z.discriminatedUnion("type", [
  AuditRecordJournalEntrySchema,
  SemanticComparisonJournalEntrySchema,
]);
export type EvaluationJournalEntry = z.infer<
  typeof EvaluationJournalEntrySchema
>;

/** Spec §5 Step E prose: state and journal event applied in one transaction. */
export const CommitSchema = z
  .object({
    chunkId: ChunkIdSchema,
    memory: MemorySchema,
    journalEntry: z.discriminatedUnion("type", [
      CommittedUpdateJournalEntrySchema,
      NoUpdateJournalEntrySchema,
    ]),
  })
  .strict();
export type Commit = z.infer<typeof CommitSchema>;
