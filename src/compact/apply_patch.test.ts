import { expect, test } from "bun:test";
import type { Memory } from "../schema";
import { applyPatch } from "./apply_patch";

test("applies existing and new topics atomically without mutating input", () => {
  const memory = {
    revision: 1,
    topics: [
      {
        id: "topic-1",
        title: "A",
        description: "A",
        version: 1,
        summary: "old",
        sources: [],
        unresolved: [],
      },
    ],
    protected: [],
    processedChunkIds: [],
  } as unknown as Memory;
  const result = applyPatch(
    memory,
    {
      replacements: [
        {
          topicId: "topic-1" as never,
          expectedVersion: 1,
          title: "A",
          description: "A",
          summary: "new",
          sources: [],
          unresolved: [],
        },
      ],
      newTopics: [
        {
          title: "B",
          description: "B",
          summary: "B",
          sources: [],
          unresolved: [],
        },
      ],
      addProtected: [],
      supersedeProtected: [],
    },
    "chunk-1" as never,
    () => "topic-2" as never,
  );
  expect(result.revision).toBe(2);
  expect(result.topics.map(({ id, version }) => [String(id), version])).toEqual(
    [
      ["topic-1", 2],
      ["topic-2", 1],
    ],
  );
  expect(memory.topics[0]?.summary).toBe("old");
});

test("default topic ids skip identities already in memory", () => {
  const occupied = {
    revision: 1,
    topics: [
      {
        id: "topic-2-1",
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
  const result = applyPatch(occupied, {
    replacements: [],
    newTopics: [
      {
        title: "B",
        description: "B",
        summary: "B",
        sources: [],
        unresolved: [],
      },
    ],
    addProtected: [],
    supersedeProtected: [],
  });
  expect(result.topics.map(({ id }) => String(id))).toEqual([
    "topic-2-1",
    "topic-2-2",
  ]);
});
