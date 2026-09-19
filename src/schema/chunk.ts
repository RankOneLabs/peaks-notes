import { z } from "zod";
import { ChunkIdSchema, MessageIdSchema } from "./ids";

const TextMessageSchema = z
  .object({
    id: MessageIdSchema,
    role: z.enum(["system", "user", "assistant"]),
    content: z.string(),
  })
  .strict();

/**
 * Spec §5 Step A: host-provided action metadata. A read-only call is not
 * protected; a state-changing call is reduced to a receipt that keeps
 * `receiptArguments` (default: every argument) and the result's error flag.
 * A call without metadata is protected verbatim.
 */
export const ToolActionSchema = z.discriminatedUnion("effect", [
  z.object({ effect: z.literal("read_only") }).strict(),
  z
    .object({
      effect: z.literal("state_changing"),
      receiptArguments: z.array(z.string().min(1)).min(1).optional(),
    })
    .strict(),
]);
export type ToolAction = z.infer<typeof ToolActionSchema>;

const ToolCallMessageSchema = z
  .object({
    id: MessageIdSchema,
    role: z.literal("assistant"),
    content: z.string(),
    toolCall: z
      .object({
        id: z.string().min(1),
        name: z.string().min(1),
        arguments: z.unknown(),
        action: ToolActionSchema.optional(),
      })
      .strict(),
  })
  .strict();

const ToolResultMessageSchema = z
  .object({
    id: MessageIdSchema,
    role: z.literal("tool"),
    content: z.string(),
    toolResult: z
      .object({ callId: z.string().min(1), isError: z.boolean().optional() })
      .strict(),
  })
  .strict();

/** Spec §3 prose: a source message, including explicit tool call/result records. */
export const MessageSchema = z.union([
  ToolCallMessageSchema,
  ToolResultMessageSchema,
  TextMessageSchema,
]);
export type Message = z.infer<typeof MessageSchema>;

/** Spec §3: an ordered segment whose tool calls and results are complete pairs. */
export const ChunkSchema = z
  .object({
    id: ChunkIdSchema,
    messages: z.array(MessageSchema).min(1),
    createdAt: z.string().datetime(),
  })
  .strict()
  .superRefine((chunk, context) => {
    const calls = new Map<string, number>();
    const results = new Map<string, number>();
    for (const [index, message] of chunk.messages.entries()) {
      if ("toolCall" in message) {
        if (calls.has(message.toolCall.id)) {
          context.addIssue({
            code: "custom",
            path: ["messages", index],
            message: "duplicate tool call id",
          });
        }
        calls.set(message.toolCall.id, index);
        const { action, arguments: args } = message.toolCall;
        if (
          action?.effect === "state_changing" &&
          action.receiptArguments !== undefined &&
          (typeof args !== "object" || args === null || Array.isArray(args))
        ) {
          context.addIssue({
            code: "custom",
            path: ["messages", index, "toolCall", "arguments"],
            message: "receiptArguments requires object arguments",
          });
        }
      }
      if ("toolResult" in message) {
        if (results.has(message.toolResult.callId)) {
          context.addIssue({
            code: "custom",
            path: ["messages", index],
            message: "duplicate tool result",
          });
        }
        results.set(message.toolResult.callId, index);
      }
    }
    for (const [callId, callIndex] of calls) {
      const resultIndex = results.get(callId);
      if (resultIndex === undefined) {
        context.addIssue({
          code: "custom",
          message: `tool call ${callId} has no result`,
        });
      } else if (resultIndex < callIndex) {
        context.addIssue({
          code: "custom",
          message: `tool result ${callId} precedes its call`,
        });
      }
    }
    for (const callId of results.keys()) {
      if (!calls.has(callId)) {
        context.addIssue({
          code: "custom",
          message: `tool result ${callId} has no call`,
        });
      }
    }
  });
export type Chunk = z.infer<typeof ChunkSchema>;
