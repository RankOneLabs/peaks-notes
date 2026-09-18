import { describe, expect, test } from "bun:test";
import { MemoryPatchSchema } from "./writer";

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
