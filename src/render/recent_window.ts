import type { Message } from "../schema";

export const DEFAULT_RECENT_MESSAGE_COUNT = 6;

/** Select a suffix and extend it so a tool call/result pair is never split. */
export const recentWindow = (
  messages: readonly Message[],
  count = DEFAULT_RECENT_MESSAGE_COUNT,
): Message[] => {
  if (messages.length <= count) return structuredClone([...messages]);
  let start = Math.max(0, messages.length - count);
  let end = messages.length;

  const selectedCallIds = new Set<string>();
  for (let index = start; index < end; index += 1) {
    const item = messages[index];
    if (item !== undefined && "toolCall" in item)
      selectedCallIds.add(item.toolCall.id);
    if (item !== undefined && "toolResult" in item) {
      const callIndex = messages.findIndex(
        (candidate) =>
          "toolCall" in candidate &&
          candidate.toolCall.id === item.toolResult.callId,
      );
      if (callIndex >= 0) start = Math.min(start, callIndex);
    }
  }
  for (const callId of selectedCallIds) {
    const resultIndex = messages.findIndex(
      (candidate) =>
        "toolResult" in candidate && candidate.toolResult.callId === callId,
    );
    if (resultIndex >= end) end = resultIndex + 1;
  }
  return structuredClone(messages.slice(start, end));
};
