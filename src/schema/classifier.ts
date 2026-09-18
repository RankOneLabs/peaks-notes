import { z } from "zod";
import { ChunkSchema } from "./chunk";
import { TopicIdSchema } from "./ids";
import { ProtectedRecordSchema, TopicSchema } from "./memory";
import { TaskContextSchema } from "./task";

/** Spec §5 Step B prose: the complete relevance-scoring request. */
export const RelevanceInputSchema = z
  .object({
    chunk: ChunkSchema,
    taskContext: TaskContextSchema,
    topics: z.array(
      TopicSchema.pick({ id: true, title: true, description: true }),
    ),
  })
  .strict();
export type RelevanceInput = z.infer<typeof RelevanceInputSchema>;

/** Spec §5 Step B: independent scores for every catalog topic. */
export const RelevanceResultSchema = z
  .object({
    topics: z.array(
      z.object({ topicId: TopicIdSchema, score: z.number().finite() }).strict(),
    ),
  })
  .strict();
export type RelevanceResult = z.infer<typeof RelevanceResultSchema>;

/** Spec §5 Step B: thresholds are measured policy, not hard-coded assumptions. */
export const ClassifierPolicySchema = z
  .object({
    relevanceThreshold: z.number().finite(),
    sameInfoMinConfidence: z.number().finite(),
    uncoveredNoChangeMinConfidence: z.number().finite(),
  })
  .strict();
export type ClassifierPolicy = z.infer<typeof ClassifierPolicySchema>;

/** Spec §5 Step C: relationship labels for selected topic summaries. */
export const RelationshipSchema = z.enum([
  "new_info",
  "changing_info",
  "same_info",
]);
export type Relationship = z.infer<typeof RelationshipSchema>;

/** Spec §5 Step C prose: full evidence for selected-topic classification. */
export const RelationshipInputSchema = z
  .object({
    chunk: ChunkSchema,
    taskContext: TaskContextSchema,
    selectedTopics: z.array(TopicSchema),
    topicCatalog: z.array(
      TopicSchema.pick({ id: true, title: true, description: true }),
    ),
    protectedRecords: z.array(ProtectedRecordSchema),
  })
  .strict();
export type RelationshipInput = z.infer<typeof RelationshipInputSchema>;

/** Spec §5 Step C: per-topic relationships plus the global uncovered outcome. */
export const AssessmentSchema = z
  .object({
    relations: z.array(
      z
        .object({
          topicId: TopicIdSchema,
          relationship: RelationshipSchema,
          confidence: z.number().finite(),
        })
        .strict(),
    ),
    uncovered: z
      .object({
        outcome: z.enum(["none", "new_topic", "transient", "uncertain"]),
        confidence: z.number().finite(),
      })
      .strict(),
  })
  .strict();
export type Assessment = z.infer<typeof AssessmentSchema>;

/** Spec §7: provider-neutral classifier contract. */
export interface Classifier {
  scoreRelevance(input: RelevanceInput): Promise<RelevanceResult>;
  classifyRelationships(input: RelationshipInput): Promise<Assessment>;
}
