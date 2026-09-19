import { expect, test } from "bun:test";
import type { UpdateInput } from "../schema";
import { LlmWriter } from "./llm_writer";
import { parseMemoryPatch } from "./parse";
import { AdapterError } from "./provider";
import { RecordedProvider } from "./recorded";

test("parses an exact MemoryPatch JSON object", () => {
  expect(
    parseMemoryPatch(
      JSON.stringify({ replacements: [], newTopics: [], addProtected: [], supersedeProtected: [] }),
    ),
  ).toEqual({ replacements: [], newTopics: [], addProtected: [], supersedeProtected: [] });
});

test("rejects malformed JSON and non-patch output", () => {
  expect(() => parseMemoryPatch("not json")).toThrow("not valid JSON");
  expect(() => parseMemoryPatch("{}")).toThrow("not a MemoryPatch");
});

const input: UpdateInput = {
  chunk: {
    id: "chunk-1" as never,
    createdAt: "2026-09-18T00:00:00.000Z",
    messages: [{ id: "message-1" as never, role: "user", content: "hello" }],
  },
  memory: { revision: 0, topics: [], protected: [], processedChunkIds: [] },
  taskContext: { currentTask: "test", compactionInstructions: [] },
  affectedTopicIds: [],
};

const config = {
  provider: "openai" as const,
  apiKey: "unused",
  model: "recorded-model",
  deadlineMs: 100,
  promptVersion: "writer-test",
  maxInputTokens: 32_000,
};

test("recorded invalid output is a typed invalid_response", async () => {
  const writer = new LlmWriter(
    new RecordedProvider([
      {
        response: {
          text: "not json",
          model: "recorded-model",
          usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
        },
      },
    ]),
    config,
  );
  try {
    await writer.propose(input);
    throw new Error("expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).code).toBe("invalid_response");
    expect((error as AdapterError).usage.usage.totalTokens).toBe(6);
  }
});

test("deadline expiry is typed and includes elapsed usage", async () => {
  const writer = new LlmWriter(
    { id: "never", generate: () => new Promise(() => {}) },
    { ...config, deadlineMs: 2 },
  );
  try {
    await writer.propose(input);
    throw new Error("expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).code).toBe("timeout");
    expect((error as AdapterError).usage.latencyMs).toBeGreaterThanOrEqual(1);
  }
});
