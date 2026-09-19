import type { Message } from "../schema";

export const DEFAULT_RECENT_MESSAGE_COUNT = 6;

/** Select a suffix and extend it so a tool call/result pair is never split. */
export const recentWindow = (
  messages: readonly Message[],
  count = DEFAULT_RECENT_MESSAGE_COUNT,
): Message[] => {
  if (messages.length <= count) return structuredClone([...messages]);
  let start = Math.max(0, messages.length - count);
  const end = messages.length;

  let previousStart: number;
  do {
    previousStart = start;
    for (let index = start; index < end; index += 1) {
      const item = messages[index];
      if (item !== undefined && "toolResult" in item) {
        const callIndex = messages.findIndex(
          (candidate) =>
            "toolCall" in candidate &&
            candidate.toolCall.id === item.toolResult.callId,
        );
        if (callIndex >= 0) start = Math.min(start, callIndex);
      }
    }
  } while (start < previousStart);
  return structuredClone(messages.slice(start, end));
};
