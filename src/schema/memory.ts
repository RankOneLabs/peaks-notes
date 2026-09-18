import { z } from "zod";
import {
  ChunkIdSchema,
  MessageIdSchema,
  ProtectedRecordIdSchema,
  TopicIdSchema,
} from "./ids";

/** Spec §4: exact source span supporting stored state. */
export const SourceRefSchema = z
  .object({
    messageId: MessageIdSchema,
    start: z.number().int().nonnegative().optional(),
    end: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.start === undefined ||
      value.end === undefined ||
      value.start <= value.end,
    {
      message: "source start must not exceed end",
    },
  );
export type SourceRef = z.infer<typeof SourceRefSchema>;

/** Spec §4: one stable, versioned topic section. */
export const TopicSchema = z
  .object({
    id: TopicIdSchema,
    title: z.string().min(1),
    description: z.string(),
    version: z.number().int().positive(),
    summary: z.string(),
    sources: z.array(SourceRefSchema),
    unresolved: z.array(z.string()),
  })
  .strict();
export type Topic = z.infer<typeof TopicSchema>;

/** Spec §4: verbatim information that compaction must preserve. */
export const ProtectedRecordSchema = z
  .object({
    id: ProtectedRecordIdSchema,
    kind: z.enum(["constraint", "decision", "action_receipt", "explicit_pin"]),
    text: z.string(),
    sources: z.array(SourceRefSchema),
    status: z.enum(["active", "superseded"]),
    supersededBy: ProtectedRecordIdSchema.optional(),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.status === "active" && record.supersededBy !== undefined) {
      context.addIssue({
        code: "custom",
        message: "an active record cannot be superseded",
      });
    }
  });
export type ProtectedRecord = z.infer<typeof ProtectedRecordSchema>;

/** Spec §4: the complete active memory document. */
export const MemorySchema = z
  .object({
    revision: z.number().int().nonnegative(),
    topics: z.array(TopicSchema),
    protected: z.array(ProtectedRecordSchema),
    processedChunkIds: z.array(ChunkIdSchema),
  })
  .strict();
export type Memory = z.infer<typeof MemorySchema>;

export const emptyMemory = (): Memory => ({
  revision: 0,
  topics: [],
  protected: [],
  processedChunkIds: [],
});
