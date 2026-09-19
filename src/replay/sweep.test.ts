import { expect, test } from "bun:test";
import type { MetricsReport } from "./metrics";
import { assertDevelopmentFixtures, choosePolicy, enumeratePolicies } from "./sweep";

const metrics = (recall: number, misses: number): MetricsReport => ({
  fixtures: 1,
  relevance: { truePositive: 1, falsePositive: 0, falseNegative: 0, recall, precision: 1 },
  selectedTopicsPerChunk: 1,
  falseNoUpdates: {
    count: misses,
    requiredUpdateCount: 1,
    rate: misses,
    amongBypassesRate: misses,
    byGate: { relevance: misses, sameInfo: 0, uncoveredContent: 0 },
  },
  newVersusChanging: { expectedNewPredictedChanging: 0, expectedChangingPredictedNew: 0 },
  semantic: {
    equivalent: 0,
    material: 0,
    requiredUpdate: 0,
    writerRegression: 0,
    inconclusive: 0,
    agreementDenominator: 0,
    confirmedMissDenominator: 0,
    agreementRate: null,
    confirmedMissRate: null,
  },
  audits: { eligible: 0, sampled: 0, completed: 0, failed: 0, samplingProbability: null },
  model: {
    classifier: { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, latencyMs: 0, costUsd: 0 },
    writer: { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, latencyMs: 0, costUsd: 0 },
    evaluator: { calls: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, latencyMs: 0, costUsd: 0 },
  },
  savings: { potentialWriterCallsShadow: 0, realizedWriterCallsActive: 0, auditOverheadCalls: 0 },
  protectedContentLosses: 0,
  missedCriticalUpdates: misses,
  humanSpotChecks: [],
});

test("sweep favors safety before relevance score", () => {
  const safe = { relevanceThreshold: 0.3, sameInfoMinConfidence: 0.9, uncoveredNoChangeMinConfidence: 0.9 };
  const unsafe = { relevanceThreshold: 0.5, sameInfoMinConfidence: 0.8, uncoveredNoChangeMinConfidence: 0.8 };
  expect(
    choosePolicy([
      { policy: unsafe, metrics: metrics(1, 1) },
      { policy: safe, metrics: metrics(0.8, 0) },
    ]).policy,
  ).toEqual(safe);
});

test("grid enumerates every threshold combination", () => {
  expect(
    enumeratePolicies({
      relevanceThreshold: [0.3, 0.5],
      sameInfoMinConfidence: [0.8, 0.9],
      uncoveredNoChangeMinConfidence: [0.8],
    }),
  ).toHaveLength(4);
});

test("threshold tuning rejects the held-out directory", async () => {
  await expect(assertDevelopmentFixtures("fixtures/held_out")).rejects.toThrow(
    "refuses held-out",
  );
});
