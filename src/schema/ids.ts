import { z } from "zod";

export const MessageIdSchema = z.string().min(1).brand<"MessageId">();
export type MessageId = z.infer<typeof MessageIdSchema>;

export const ChunkIdSchema = z.string().min(1).brand<"ChunkId">();
export type ChunkId = z.infer<typeof ChunkIdSchema>;

export const TopicIdSchema = z.string().min(1).brand<"TopicId">();
export type TopicId = z.infer<typeof TopicIdSchema>;

export const ProtectedRecordIdSchema = z
  .string()
  .min(1)
  .brand<"ProtectedRecordId">();
export type ProtectedRecordId = z.infer<typeof ProtectedRecordIdSchema>;

export const JournalEntryIdSchema = z.string().min(1).brand<"JournalEntryId">();
export type JournalEntryId = z.infer<typeof JournalEntryIdSchema>;
