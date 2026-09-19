import { z } from "zod";
import { err, ok, type Result } from "../../schema";

/*
 * Claude Code transcript JSONL is not a published API. These schemas declare
 * only the fields peaks reads; unknown fields are stripped, not rejected.
 */

const TextBlockSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});
export type TextBlock = z.infer<typeof TextBlockSchema>;

const ToolUseBlockSchema = z.object({
  type: z.literal("tool_use"),
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.unknown(),
});
export type ToolUseBlock = z.infer<typeof ToolUseBlockSchema>;

const ToolResultBlockSchema = z.object({
  type: z.literal("tool_result"),
  tool_use_id: z.string().min(1),
  content: z
    .union([
      z.string(),
      z.array(z.object({ type: z.string(), text: z.string().optional() })),
    ])
    .optional(),
  is_error: z.boolean().optional(),
});
export type ToolResultBlock = z.infer<typeof ToolResultBlockSchema>;

const READ_BLOCK_TYPES = new Set(["text", "tool_use", "tool_result"]);

/**
 * Thinking, images, and any block type peaks does not read. A block whose type
 * peaks does read must match that block's schema; falling back to here would
 * drop it from the summary without saying so.
 */
const OtherBlockSchema = z.object({
  type: z.string().refine((value) => !READ_BLOCK_TYPES.has(value), {
    message: "block does not match the schema for its type",
  }),
});

const ContentBlockSchema = z.union([
  TextBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
  OtherBlockSchema,
]);
export type ContentBlock = z.infer<typeof ContentBlockSchema>;

export const MessageEntrySchema = z.object({
  type: z.enum(["user", "assistant"]),
  uuid: z.string().min(1),
  parentUuid: z.string().nullable().optional(),
  timestamp: z.string(),
  isSidechain: z.boolean().optional(),
  isMeta: z.boolean().optional(),
  isCompactSummary: z.boolean().optional(),
  isVisibleInTranscriptOnly: z.boolean().optional(),
  isApiErrorMessage: z.boolean().optional(),
  origin: z.object({ kind: z.string() }).optional(),
  message: z.object({
    content: z.union([z.string(), z.array(ContentBlockSchema)]),
  }),
});
export type MessageEntry = z.infer<typeof MessageEntrySchema>;

/** Any entry with a uuid is a link in the conversation chain. */
const LinkEntrySchema = z.object({
  uuid: z.string().min(1),
  parentUuid: z.string().nullable().optional(),
  logicalParentUuid: z.string().nullable().optional(),
  isSidechain: z.boolean().optional(),
});
type LinkEntry = z.infer<typeof LinkEntrySchema>;

const AiTitleEntrySchema = z.object({
  type: z.literal("ai-title"),
  aiTitle: z.string().min(1),
});

export type TranscriptError = { code: "transcript_error"; message: string };

export type Transcript = {
  /** User and assistant entries on the active branch, oldest first. */
  entries: MessageEntry[];
  /** The latest session title Claude Code generated, when present. */
  title?: string;
};

const failure = (message: string): Result<never, TranscriptError> =>
  err({ code: "transcript_error", message });

/**
 * Parses complete JSONL lines and keeps the active branch: the parent chain of
 * the last main-thread entry. Rewound branches and duplicated lines drop out,
 * and `logicalParentUuid` carries the chain across a compaction boundary.
 */
export const parseTranscript = (
  text: string,
): Result<Transcript, TranscriptError> => {
  const links = new Map<string, LinkEntry>();
  const messages = new Map<string, MessageEntry>();
  let last: string | undefined;
  let title: string | undefined;
  for (const [index, line] of text.split("\n").entries()) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return failure(`line ${index + 1} is not JSON`);
    }
    const aiTitle = AiTitleEntrySchema.safeParse(value);
    if (aiTitle.success) title = aiTitle.data.aiTitle;
    const link = LinkEntrySchema.safeParse(value);
    if (!link.success) continue;
    links.set(link.data.uuid, link.data);
    if (link.data.isSidechain !== true) last = link.data.uuid;
    const type = (value as { type?: unknown }).type;
    if (type !== "user" && type !== "assistant") continue;
    const message = MessageEntrySchema.safeParse(value);
    if (!message.success)
      return failure(
        `line ${index + 1}: unreadable ${type} entry: ${message.error.issues
          .map(({ message: issue }) => issue)
          .join("; ")}`,
      );
    messages.set(message.data.uuid, message.data);
  }

  const chain: MessageEntry[] = [];
  const visited = new Set<string>();
  let cursor = last;
  while (cursor !== undefined && !visited.has(cursor)) {
    visited.add(cursor);
    const message = messages.get(cursor);
    if (message !== undefined && message.isSidechain !== true)
      chain.push(message);
    const link = links.get(cursor);
    cursor = link?.parentUuid ?? link?.logicalParentUuid ?? undefined;
  }
  chain.reverse();
  return ok(
    title === undefined ? { entries: chain } : { entries: chain, title },
  );
};

/**
 * Reads the transcript as it was when the Stop hook fired. A trailing line
 * without its newline is still being written and is left for the next run.
 */
export const readTranscriptPrefix = async (
  path: string,
  untilBytes: number,
): Promise<string> => {
  const text = await Bun.file(path).slice(0, untilBytes).text();
  const end = text.lastIndexOf("\n");
  return end === -1 ? "" : text.slice(0, end + 1);
};
