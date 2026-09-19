import { expect, test } from "bun:test";
import type { Message } from "../schema";
import { recentWindow } from "./recent_window";

test("a six-message window extends backward to retain the call for its result", () => {
  const messages: Message[] = [
    {
      id: "call-message" as never,
      role: "assistant",
      content: "call",
      toolCall: { id: "call-1", name: "read", arguments: {} },
    },
    ...Array.from({ length: 5 }, (_, index) => ({
      id: `middle-${index}` as never,
      role: "user" as const,
      content: "middle",
    })),
    {
      id: "result-message" as never,
      role: "tool",
      content: "result",
      toolResult: { callId: "call-1" },
    },
  ];
  expect(recentWindow(messages, 6).map(({ id }) => id)).toEqual(
    messages.map(({ id }) => id),
  );
});

test("backward expansion closes over interleaved tool pairs", () => {
  const messages: Message[] = [
    {
      id: "call-a" as never,
      role: "assistant",
      content: "call a",
      toolCall: { id: "a", name: "read", arguments: {} },
    },
    { id: "middle" as never, role: "user", content: "middle" },
    {
      id: "call-b" as never,
      role: "assistant",
      content: "call b",
      toolCall: { id: "b", name: "read", arguments: {} },
    },
    {
      id: "result-a" as never,
      role: "tool",
      content: "a",
      toolResult: { callId: "a" },
    },
    { id: "later" as never, role: "assistant", content: "later" },
    {
      id: "result-b" as never,
      role: "tool",
      content: "b",
      toolResult: { callId: "b" },
    },
  ];
  expect(recentWindow(messages, 1).map(({ id }) => id)).toEqual(
    messages.map(({ id }) => id),
  );
});
