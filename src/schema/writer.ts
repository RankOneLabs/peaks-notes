import { z } from "zod";
import { ChunkSchema } from "./chunk";
import { AssessmentSchema } from "./classifier";
import { ProtectedRecordIdSchema, TopicIdSchema } from "./ids";
import {
  MemorySchema,
  ProtectedRecordSchema,
  SourceRefSchema,
  TopicSchema,
} from "./memory";
import { TaskContextSchema } from "./task";

export const TopicReplacementSchema = z
  .object({
    topicId: TopicIdSchema,
    expectedVersion: z.number().int().positive(),
    title: z.string().min(1),
    description: z.string(),
    summary: z.string(),
    sources: z.array(SourceRefSchema),
    unresolved: z.array(z.string()),
  })
  .strict();
export type TopicReplacement = z.infer<typeof TopicReplacementSchema>;

export const NewTopicSchema = TopicSchema.omit({
  id: true,
  version: true,
}).strict();
export type NewTopic = z.infer<typeof NewTopicSchema>;

/** Spec §5 Step D prose: full writer evidence and current snapshot. */
export const UpdateInputSchema = z
  .object({
    chunk: ChunkSchema,
    memory: MemorySchema,
    taskContext: TaskContextSchema,
    affectedTopicIds: z.array(TopicIdSchema),
    assessment: AssessmentSchema.optional(),
  })
  .strict();
export type UpdateInput = z.infer<typeof UpdateInputSchema>;

/** Spec §5 Step D: structured, multi-topic update proposed by the writer. */
export const MemoryPatchSchema = z
  .object({
    replacements: z.array(TopicReplacementSchema),
    newTopics: z.array(NewTopicSchema),
    addProtected: z.array(ProtectedRecordSchema),
    supersedeProtected: z.array(
      z
        .object({
          id: ProtectedRecordIdSchema,
          supersededBy: ProtectedRecordIdSchema,
        })
        .strict(),
    ),
  })
  .strict();
export type MemoryPatch = z.infer<typeof MemoryPatchSchema>;

/** Writer-facing response shape: writers may add only active constraints and decisions. */
export const WriterMemoryPatchSchema = MemoryPatchSchema.extend({
  addProtected: z.array(
    z
      .object({
        id: ProtectedRecordIdSchema,
        kind: z.enum(["constraint", "decision"]),
        text: z.string().min(1),
        sources: z.array(SourceRefSchema).min(1),
        status: z.literal("active"),
      })
      .strict(),
  ),
}).strict();

/** Spec §6 prose: exceptional one-pass global compression request. */
export const CompressInputSchema = z
  .object({
    memory: MemorySchema,
    taskContext: TaskContextSchema,
    maxSummaryTokens: z.number().int().positive(),
  })
  .strict();
export type CompressInput = z.infer<typeof CompressInputSchema>;

/** Lets the pipeline cancel a model call whose deadline has expired. */
export type CallOptions = { signal?: AbortSignal };

/** Spec §7 plus §6: writer owns both update proposals and exceptional compression. */
export interface Writer {
  propose(input: UpdateInput, options?: CallOptions): Promise<MemoryPatch>;
  compress(input: CompressInput, options?: CallOptions): Promise<MemoryPatch>;
}
