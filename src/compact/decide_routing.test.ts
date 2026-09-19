import { expect, test } from "bun:test";
import type { Topic } from "../schema";
import { decideRouting } from "./decide_routing";

const selected = [
  {
    id: "a",
    title: "A",
    description: "A",
    version: 1,
    summary: "A",
    sources: [],
    unresolved: [],
  },
] as unknown as Topic[];
const policy = {
  relevanceThreshold: 0.5,
  sameInfoMinConfidence: 0.8,
  uncoveredNoChangeMinConfidence: 0.8,
};

test("changing_info takes precedence over new_info for one topic", () => {
  const result = decideRouting(
    selected,
    {
      relations: [
        { topicId: "a" as never, relationship: "new_info", confidence: 0.9 },
        {
          topicId: "a" as never,
          relationship: "changing_info",
          confidence: 0.9,
        },
      ],
      uncovered: { outcome: "none", confidence: 0.9 },
    },
    policy,
  );
  expect(result).toMatchObject({
    ok: true,
    value: {
      kind: "writer",
      affectedTopicIds: ["a"],
      reason: "new_or_changing_info",
    },
  });
});

test("confident same info and no uncovered content bypasses", () => {
  const result = decideRouting(
    selected,
    {
      relations: [
        { topicId: "a" as never, relationship: "same_info", confidence: 0.9 },
      ],
      uncovered: { outcome: "none", confidence: 0.9 },
    },
    policy,
  );
  expect(result.ok && result.value.kind).toBe("bypass");
});
