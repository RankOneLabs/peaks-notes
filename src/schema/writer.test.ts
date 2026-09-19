import { describe, expect, test } from "bun:test";
import { SourceRefSchema } from "./memory";
import { MemoryPatchSchema, UpdateInputSchema } from "./writer";

const emptyPatch = {
  replacements: [],
  newTopics: [],
  addProtected: [],
  supersedeProtected: [],
};

describe("MemoryPatchSchema", () => {
  test("rejects a replacement without expectedVersion", () => {
    expect(
      MemoryPatchSchema.safeParse({
        ...emptyPatch,
        replacements: [
          {
            topicId: "topic-1",
            title: "Title",
            description: "Description",
            summary: "Summary",
            sources: [],
            unresolved: [],
          },
        ],
      }).success,
    ).toBe(false);
  });

  test("rejects a new topic that supplies its own id", () => {
    expect(
      MemoryPatchSchema.safeParse({
        ...emptyPatch,
        newTopics: [
          {
            id: "caller-controlled",
            title: "Title",
            description: "Description",
            summary: "Summary",
            sources: [],
            unresolved: [],
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("UpdateInputSchema", () => {
  test("carries the complete validated chunk rather than only its id", () => {
    const result = UpdateInputSchema.safeParse({
      chunk: {
        id: "chunk-1",
        createdAt: "2026-09-18T00:00:00.000Z",
        messages: [
          { id: "message-1", role: "user", content: "Remember this." },
        ],
      },
      memory: { revision: 0, topics: [], protected: [], processedChunkIds: [] },
      taskContext: { currentTask: "Build", compactionInstructions: [] },
      affectedTopicIds: [],
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.chunk.messages).toHaveLength(1);
  });
});

describe("SourceRefSchema", () => {
  test.each([
    [{ messageId: "m" }, true],
    [{ messageId: "m", start: 0, end: 0 }, true],
    [{ messageId: "m", start: 2, end: 5 }, true],
    [{ messageId: "m", start: 2 }, false],
    [{ messageId: "m", end: 5 }, false],
    [{ messageId: "m", start: 5, end: 2 }, false],
  ])("%j parses: %p", (value, valid) => {
    expect(SourceRefSchema.safeParse(value).success).toBe(valid);
  });
});
