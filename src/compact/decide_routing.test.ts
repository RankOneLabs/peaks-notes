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

test("confident no meaningful addition bypasses with a distinct reason", () => {
  const result = decideRouting(
    selected,
    {
      relations: [
        {
          topicId: "a" as never,
          relationship: "no_meaningful_addition",
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
      kind: "bypass",
      reason: "no_meaningful_addition_and_uncovered_none",
    },
  });
});

test("low-confidence no meaningful addition still reaches the writer", () => {
  const result = decideRouting(
    selected,
    {
      relations: [
        {
          topicId: "a" as never,
          relationship: "no_meaningful_addition",
          confidence: 0.79,
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
      reason: "low_confidence_no_meaningful_addition",
    },
  });
});

test("equal-ranked relations use the lowest confidence regardless of order", () => {
  const relation = (confidence: number) => ({
    topicId: "a" as never,
    relationship: "same_info" as const,
    confidence,
  });
  for (const relations of [
    [relation(0.9), relation(0.1)],
    [relation(0.1), relation(0.9)],
  ]) {
    const result = decideRouting(
      selected,
      {
        relations,
        uncovered: { outcome: "none", confidence: 0.9 },
      },
      policy,
    );
    expect(result).toMatchObject({
      ok: true,
      value: { kind: "writer", reason: "low_confidence_same_info" },
    });
  }
});

test("confidence exactly at a threshold still bypasses", () => {
  const route = (same: number, uncovered: number) => {
    const result = decideRouting(
      selected,
      {
        relations: [
          {
            topicId: "a" as never,
            relationship: "same_info",
            confidence: same,
          },
        ],
        uncovered: { outcome: "none", confidence: uncovered },
      },
      policy,
    );
    return result.ok ? result.value.kind : "error";
  };
  expect(route(0.8, 0.8)).toBe("bypass");
  expect(route(0.79, 0.8)).toBe("writer");
  expect(route(0.8, 0.79)).toBe("writer");
});
