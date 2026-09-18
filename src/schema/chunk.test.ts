import { describe, expect, test } from "bun:test";
import { ChunkSchema } from "./chunk";

const base = {
  id: "chunk-1",
  createdAt: "2026-09-18T00:00:00.000Z",
};

describe("ChunkSchema", () => {
  test("rejects an unresolved tool call", () => {
    const result = ChunkSchema.safeParse({
      ...base,
      messages: [
        {
          id: "message-1",
          role: "assistant",
          content: "calling",
          toolCall: { id: "call-1", name: "read", arguments: {} },
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  test("accepts a paired tool call and result", () => {
    const result = ChunkSchema.safeParse({
      ...base,
      messages: [
        {
          id: "message-1",
          role: "assistant",
          content: "calling",
          toolCall: { id: "call-1", name: "read", arguments: {} },
        },
        {
          id: "message-2",
          role: "tool",
          content: "done",
          toolResult: { callId: "call-1" },
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});
