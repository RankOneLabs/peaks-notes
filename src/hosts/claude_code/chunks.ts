import { z } from "zod";
import {
  type Chunk,
  ChunkSchema,
  err,
  ok,
  type Result,
  type ToolAction,
} from "../../schema";
import { CLAUDE_CODE_TOOL_ACTIONS } from "./tools";
import type {
  ContentBlock,
  MessageEntry,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
  TranscriptError,
} from "./transcript";

/** `chat` keeps typed prompts and assistant replies; `tools` adds tool records. */
export const ContentModeSchema = z.enum(["chat", "tools"]);
export type ContentMode = z.infer<typeof ContentModeSchema>;

type DraftMessage =
  | { id: string; role: "user" | "assistant"; content: string }
  | {
      id: string;
      role: "assistant";
      content: string;
      toolCall: {
        id: string;
        name: string;
        arguments: unknown;
        action?: ToolAction;
      };
    }
  | {
      id: string;
      role: "tool";
      content: string;
      toolResult: { callId: string; isError?: boolean };
    };

type Turn = { prompt: MessageEntry; text: string; replies: MessageEntry[] };

const COMMAND_OUTPUT =
  /^<(?:command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>/;
const INTERRUPTION = /^\[Request interrupted by user/;
const SLASH_COMMAND = /^\/[\w:-]+(?:\s|$)/;

const isText = (block: ContentBlock): block is TextBlock =>
  block.type === "text" && "text" in block;
const isToolUse = (block: ContentBlock): block is ToolUseBlock =>
  block.type === "tool_use" && "name" in block;
const isToolResult = (block: ContentBlock): block is ToolResultBlock =>
  block.type === "tool_result" && "tool_use_id" in block;

const blockText = (blocks: ContentBlock[]): string =>
  blocks
    .map((block) =>
      isText(block) ? block.text : block.type === "image" ? "[image]" : "",
    )
    .filter((text) => text !== "")
    .join("\n");

/**
 * The text of a prompt the user sent, or undefined for everything else a user
 * entry carries: tool results, injected context, slash-command output, the
 * compaction summary, and interruption markers. Current Claude Code marks
 * typed and SDK prompts with `origin.kind: "human"`; entries without an origin
 * fall back to text markers.
 */
const promptText = (entry: MessageEntry): string | undefined => {
  if (
    entry.type !== "user" ||
    entry.isMeta === true ||
    entry.isCompactSummary === true ||
    entry.isVisibleInTranscriptOnly === true
  )
    return undefined;
  if (entry.origin !== undefined && entry.origin.kind !== "human")
    return undefined;
  const { content } = entry.message;
  if (typeof content !== "string" && content.some(isToolResult))
    return undefined;
  const text = typeof content === "string" ? content : blockText(content);
  if (text.trim() === "") return undefined;
  if (
    entry.origin === undefined &&
    (COMMAND_OUTPUT.test(text) ||
      INTERRUPTION.test(text) ||
      SLASH_COMMAND.test(text))
  )
    return undefined;
  return text;
};

/** A turn runs from one user prompt to the next; anything earlier is dropped. */
const turns = (entries: MessageEntry[]): Turn[] => {
  const result: Turn[] = [];
  for (const entry of entries) {
    const text = promptText(entry);
    if (text !== undefined) result.push({ prompt: entry, text, replies: [] });
    else result.at(-1)?.replies.push(entry);
  }
  return result;
};

const resultText = (block: ToolResultBlock): string => {
  if (block.content === undefined) return "";
  if (typeof block.content === "string") return block.content;
  return block.content.map((item) => item.text ?? `[${item.type}]`).join("\n");
};

const toolAction = (name: string): ToolAction | undefined =>
  Object.hasOwn(CLAUDE_CODE_TOOL_ACTIONS, name)
    ? CLAUDE_CODE_TOOL_ACTIONS[name]
    : undefined;

const replyMessages = (
  entry: MessageEntry,
  mode: ContentMode,
): DraftMessage[] => {
  if (entry.isApiErrorMessage === true) return [];
  const { content } = entry.message;
  const blocks: ContentBlock[] =
    typeof content === "string" ? [{ type: "text", text: content }] : content;
  const messages: DraftMessage[] = [];
  for (const [index, block] of blocks.entries()) {
    const id = `${entry.uuid}:${index}`;
    if (entry.type === "assistant" && isText(block)) {
      if (block.text.trim() !== "")
        messages.push({ id, role: "assistant", content: block.text });
    } else if (
      mode === "tools" &&
      entry.type === "assistant" &&
      isToolUse(block)
    ) {
      const action = toolAction(block.name);
      messages.push({
        id,
        role: "assistant",
        content: "",
        toolCall: {
          id: block.id,
          name: block.name,
          arguments: block.input,
          ...(action === undefined ? {} : { action }),
        },
      });
    } else if (
      mode === "tools" &&
      entry.type === "user" &&
      isToolResult(block)
    ) {
      messages.push({
        id,
        role: "tool",
        content: resultText(block),
        toolResult: {
          callId: block.tool_use_id,
          ...(block.is_error === undefined ? {} : { isError: block.is_error }),
        },
      });
    }
  }
  return messages;
};

/** Spec §3: never summarize an unresolved call, so drop unpaired tool records. */
const pairedOnly = (messages: DraftMessage[]): DraftMessage[] => {
  const calls = new Set<string>();
  const paired = new Set<string>();
  for (const message of messages) {
    if ("toolCall" in message) calls.add(message.toolCall.id);
    else if ("toolResult" in message && calls.has(message.toolResult.callId))
      paired.add(message.toolResult.callId);
  }
  const keptCalls = new Set<string>();
  const keptResults = new Set<string>();
  return messages.filter((message) => {
    if ("toolCall" in message) {
      const { id } = message.toolCall;
      if (!paired.has(id) || keptCalls.has(id)) return false;
      keptCalls.add(id);
      return true;
    }
    if ("toolResult" in message) {
      const { callId } = message.toolResult;
      if (!paired.has(callId) || keptResults.has(callId)) return false;
      keptResults.add(callId);
      return true;
    }
    return true;
  });
};

/** One chunk per turn: the user's prompt and what followed it in `mode`. */
export const turnChunks = (
  entries: MessageEntry[],
  mode: ContentMode,
): Result<Chunk[], TranscriptError> => {
  const chunks: Chunk[] = [];
  for (const turn of turns(entries)) {
    const messages: DraftMessage[] = [
      { id: turn.prompt.uuid, role: "user", content: turn.text },
      ...turn.replies.flatMap((entry) => replyMessages(entry, mode)),
    ];
    const parsed = ChunkSchema.safeParse({
      id: `turn-${turn.prompt.uuid}`,
      createdAt: turn.prompt.timestamp,
      messages: mode === "tools" ? pairedOnly(messages) : messages,
    });
    if (!parsed.success)
      return err({
        code: "transcript_error",
        message: `turn ${turn.prompt.uuid}: ${parsed.error.issues
          .map(({ message }) => message)
          .join("; ")}`,
      });
    chunks.push(parsed.data);
  }
  return ok(chunks);
};
