import { describe, expect, test } from "bun:test";
import type { Topic } from "../schema";
import { selectTopics } from "./select_topics";

const topic = (id: string): Topic => ({ id: id as Topic["id"], title: id, description: id, version: 1, summary: id, sources: [], unresolved: [] });
const policy = { relevanceThreshold: 0.5, sameInfoMinConfidence: 0.8, uncoveredNoChangeMinConfidence: 0.8 };

describe("selectTopics", () => {
  test("selects all qualifying topics", () => {
    const result = selectTopics([topic("a"), topic("b")], { topics: [{ topicId: "a" as never, score: 0.7 }, { topicId: "b" as never, score: 0.8 }] }, policy);
    expect(result.ok && result.value.map(({ id }) => String(id))).toEqual(["a", "b"]);
  });

  test.each([
    ["missing", { topics: [] }],
    ["unknown", { topics: [{ topicId: "unknown", score: 1 }] }],
    ["NaN", { topics: [{ topicId: "a", score: Number.NaN }] }],
  ])("escalates %s scores", (_name, response) => {
    expect(selectTopics([topic("a")], response as never, policy).ok).toBe(false);
  });
});
