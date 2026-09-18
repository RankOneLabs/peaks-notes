import { z } from "zod";
import { ChunkIdSchema } from "./ids";

/** Spec §§5–7 public ingest result, including the typed §6 budget failure. */
export const IngestResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("committed"),
      chunkId: ChunkIdSchema,
      revision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      status: z.literal("no_update"),
      chunkId: ChunkIdSchema,
      revision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      status: z.literal("replayed"),
      chunkId: ChunkIdSchema,
      revision: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      status: z.literal("retained"),
      chunkId: ChunkIdSchema,
      reason: z.string(),
    })
    .strict(),
  z
    .object({
      status: z.literal("budget_exceeded"),
      chunkId: ChunkIdSchema,
      budget: z.number().int().positive(),
      required: z.number().int().nonnegative(),
    })
    .strict(),
]);
export type IngestResult = z.infer<typeof IngestResultSchema>;
