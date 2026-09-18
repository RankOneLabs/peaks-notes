import { expect, test } from "bun:test";
import type { Message } from "../schema";
import { recentWindow } from "./recent_window";

test("a six-message window extends backward to retain the call for its result", () => {
  const messages: Message[] = [
    { id: "call-message" as never, role: "assistant", content: "call", toolCall: { id: "call-1", name: "read", arguments: {} } },
    ...Array.from({ length: 5 }, (_, index) => ({ id: `middle-${index}` as never, role: "user" as const, content: "middle" })),
    { id: "result-message" as never, role: "tool", content: "result", toolResult: { callId: "call-1" } },
  ];
  expect(recentWindow(messages, 6).map(({ id }) => id)).toEqual(messages.map(({ id }) => id));
});
