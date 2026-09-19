import { expect, test } from "bun:test";
import { LlmEvaluator } from "../evaluator/llm_evaluator";
import { RecordedProvider } from "../writer/recorded";
import type { RoutingDecision } from "./decide_routing";
import { modeAction, withDeadline } from "./modes";

test("shadow and baseline always invoke writer while active honors bypass", () => {
  const bypass: RoutingDecision = {
    kind: "bypass",
    affectedTopicIds: [],
    reason: "same",
  };
  expect(modeAction("shadow", bypass)).toBe("writer");
  expect(modeAction("baseline", bypass)).toBe("writer");
  expect(modeAction("active", bypass)).toBe("bypass");
});

test("audit work has a bounded deadline", async () => {
  expect(await withDeadline(new Promise(() => {}), 1)).toEqual({
    status: "timed_out",
  });
});

test("semantically unchanged snapshots skip the evaluator provider", async () => {
  const provider = new RecordedProvider([]);
  const evaluator = new LlmEvaluator(provider, {
    provider: "openai",
    apiKey: "unused",
    model: "recorded",
    deadlineMs: 100,
    promptVersion: "evaluator-test",
    maxInputTokens: 32_000,
  });
  const before = {
    revision: 1,
    topics: [],
    protected: [],
    processedChunkIds: [],
  };
  const result = await evaluator.compare({
    before,
    after: { ...before, revision: 2 },
    chunk: {
      id: "chunk-unchanged" as never,
      createdAt: "2026-09-18T00:00:00.000Z",
      messages: [
        { id: "message-unchanged" as never, role: "user", content: "same" },
      ],
    },
    taskContext: { currentTask: "test", compactionInstructions: [] },
  });
  expect(result).toEqual({ verdict: "equivalent", changes: [] });
  expect(provider.requests).toHaveLength(0);
});
