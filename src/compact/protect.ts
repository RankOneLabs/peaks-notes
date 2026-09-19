import type { Chunk, Message, ProtectedRecord, Result } from "../schema";
import { err, ok } from "../schema";

export type ProtectionError = { code: "protection_error"; message: string };

type ToolCallMessage = Extract<Message, { toolCall: unknown }>;
type ToolResultMessage = Extract<Message, { toolResult: unknown }>;

const explicitPin =
  /\b(?:preserve|remember|keep)\b.*\b(?:exactly|verbatim|unchanged)\b/is;

const verbatim = (
  message: ToolCallMessage | ToolResultMessage,
  suffix: "call" | "result",
): ProtectedRecord => ({
  id: `protected-${message.id}-${suffix}` as ProtectedRecord["id"],
  kind: "action_receipt",
  text: JSON.stringify(message),
  sources: [{ messageId: message.id }],
  status: "active",
});

const receiptArguments = (
  args: unknown,
  keys: string[] | undefined,
): unknown => {
  if (keys === undefined || typeof args !== "object" || args === null)
    return args;
  const record = args as Record<string, unknown>;
  return Object.fromEntries(
    keys
      .filter((key) => Object.hasOwn(record, key))
      .map((key) => [key, record[key]]),
  );
};

/** Spec §5 Step A: a state-changing call keeps its declared inputs and outcome. */
const receipt = (
  call: ToolCallMessage,
  result: ToolResultMessage,
  keys: string[] | undefined,
): ProtectedRecord => ({
  id: `protected-${call.id}-receipt` as ProtectedRecord["id"],
  kind: "action_receipt",
  text: JSON.stringify({
    tool: call.toolCall.name,
    arguments: receiptArguments(call.toolCall.arguments, keys),
    isError: result.toolResult.isError ?? false,
  }),
  sources: [{ messageId: call.id }, { messageId: result.id }],
  status: "active",
});

export const protect = (
  chunk: Chunk,
): Result<ProtectedRecord[], ProtectionError> => {
  const calls = new Map<string, ToolCallMessage>();
  for (const message of chunk.messages)
    if ("toolCall" in message) calls.set(message.toolCall.id, message);
  const records: ProtectedRecord[] = [];
  for (const message of chunk.messages) {
    if ("toolCall" in message) {
      if (message.toolCall.action === undefined)
        records.push(verbatim(message, "call"));
    } else if ("toolResult" in message) {
      const call = calls.get(message.toolResult.callId);
      if (call === undefined)
        return err({
          code: "protection_error",
          message: `tool result ${message.toolResult.callId} has no call`,
        });
      const action = call.toolCall.action;
      if (action === undefined) records.push(verbatim(message, "result"));
      else if (action.effect === "state_changing")
        records.push(receipt(call, message, action.receiptArguments));
    } else if (explicitPin.test(message.content)) {
      records.push({
        id: `protected-${message.id}-pin` as ProtectedRecord["id"],
        kind: "explicit_pin",
        text: message.content,
        sources: [{ messageId: message.id }],
        status: "active",
      });
    }
  }
  return ok(records);
};
