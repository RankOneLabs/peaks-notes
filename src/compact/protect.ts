import type { Chunk, ProtectedRecord, Result } from "../schema";
import { ok } from "../schema";

export type ProtectionError = { code: "protection_error"; message: string };

const explicitPin =
  /\b(?:preserve|remember|keep)\b.*\b(?:exactly|verbatim|unchanged)\b/is;

export const protect = (
  chunk: Chunk,
): Result<ProtectedRecord[], ProtectionError> => {
  const records: ProtectedRecord[] = [];
  for (const message of chunk.messages) {
    if ("toolCall" in message) {
      records.push({
        id: `protected-${message.id}-call` as ProtectedRecord["id"],
        kind: "action_receipt",
        text: JSON.stringify(message),
        sources: [{ messageId: message.id }],
        status: "active",
      });
    } else if ("toolResult" in message) {
      records.push({
        id: `protected-${message.id}-result` as ProtectedRecord["id"],
        kind: "action_receipt",
        text: JSON.stringify(message),
        sources: [{ messageId: message.id }],
        status: "active",
      });
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
