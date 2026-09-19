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
  let observed: AbortSignal | undefined;
  let liveAtSnapshot: boolean | undefined;
  const result = await withDeadline(
    (signal) => {
      observed = signal;
      return new Promise(() => {});
    },
    1,
    () => {
      liveAtSnapshot = observed?.aborted === false;
    },
  );
  expect(result).toEqual({ status: "timed_out" });
  expect(liveAtSnapshot).toBe(true);
  expect(observed?.aborted).toBe(true);
});

test("semantically unchanged snapshots skip the evaluator provider", async () => {
  const provider = new RecordedProvider([]);
  const evaluator = new LlmEvaluator(provider, {
    provider: "openai",
    apiKey: "unused",
    model: "recorded",
    deadlineMs: 100,
    promptVersion: "evaluator-v2",
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
  expect(evaluator.getLastCall()).toMatchObject({
    provider: "recorded",
    model: "recorded",
    promptVersion: "evaluator-v2",
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  });
});
