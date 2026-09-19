import { expect, test } from "bun:test";
import type { Chunk, Memory } from "../schema";
import { validatePatch } from "./validate_patch";

const memory = {
  revision: 1,
  topics: [
    {
      id: "topic-1",
      title: "A",
      description: "A",
      version: 1,
      summary: "A",
      sources: [],
      unresolved: [],
    },
  ],
  protected: [],
  processedChunkIds: [],
} as unknown as Memory;
const chunk = {
  id: "chunk-1",
  createdAt: "2026-09-18T00:00:00.000Z",
  messages: [{ id: "message-1", role: "user", content: "B" }],
} as Chunk;

test("rejects unknown topic ids and source ids", () => {
  const base = { newTopics: [], addProtected: [], supersedeProtected: [] };
  expect(
    validatePatch(memory, chunk, {
      ...base,
      replacements: [
        {
          topicId: "missing",
          expectedVersion: 1,
          title: "A",
          description: "A",
          summary: "B",
          sources: [],
          unresolved: [],
        },
      ],
    }).ok,
  ).toBe(false);
  expect(
    validatePatch(memory, chunk, {
      ...base,
      replacements: [
        {
          topicId: "topic-1",
          expectedVersion: 1,
          title: "A",
          description: "A",
          summary: "B",
          sources: [{ messageId: "missing" }],
          unresolved: [],
        },
      ],
    }).ok,
  ).toBe(false);
});
