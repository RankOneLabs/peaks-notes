import type { ClassifierPolicy, JournalEntry, Usage } from "../schema";
import type { FixtureLabel } from "./load_fixtures";

export const JEV_INPUT_COST_PER_MILLION_TOKENS_USD = 0.042;

export type GateMissCounts = {
  relevance: number;
  sameInfo: number;
  uncoveredContent: number;
};

export type RoleMetrics = {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  latencyMs: number;
  costUsd: number;
};

export type MetricsReport = {
  fixtures: number;
  relevance: {
    truePositive: number;
    falsePositive: number;
    falseNegative: number;
    recall: number | null;
    precision: number | null;
  };
  selectedTopicsPerChunk: number;
  falseNoUpdates: {
    count: number;
    requiredUpdateCount: number;
    rate: number | null;
    amongBypassesRate: number | null;
    byGate: GateMissCounts;
  };
  newVersusChanging: {
    expectedNewPredictedChanging: number;
    expectedChangingPredictedNew: number;
  };
  semantic: {
    equivalent: number;
    material: number;
    requiredUpdate: number;
    writerRegression: number;
    inconclusive: number;
    agreementDenominator: number;
    confirmedMissDenominator: number;
    agreementRate: number | null;
    confirmedMissRate: number | null;
  };
  audits: {
    eligible: number;
    sampled: number;
    completed: number;
    failed: number;
    samplingProbability: number | null;
  };
  model: { classifier: RoleMetrics; writer: RoleMetrics; evaluator: RoleMetrics };
  savings: {
    potentialWriterCallsShadow: number;
    realizedWriterCallsActive: number;
    auditOverheadCalls: number;
  };
  protectedContentLosses: number;
  missedCriticalUpdates: number;
  humanSpotChecks: Array<{
    chunkId: string;
    fixture: string;
    verdict: "equivalent" | "material_change";
  }>;
};

const emptyRole = (): RoleMetrics => ({
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  latencyMs: 0,
  costUsd: 0,
});

const addUsage = (target: RoleMetrics, usage: Usage, latencyMs: number, jev = false): void => {
  target.calls += 1;
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.totalTokens += usage.totalTokens;
  target.latencyMs += latencyMs;
  if (jev)
    target.costUsd +=
      (usage.inputTokens / 1_000_000) * JEV_INPUT_COST_PER_MILLION_TOKENS_USD;
};

const ratio = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator;

export type ComputeMetricsInput = {
  entries: readonly JournalEntry[];
  labels: readonly FixtureLabel[];
  policy: ClassifierPolicy;
};

/** Pure evaluation transform: no adapters, clock, filesystem, or database. */
export const computeMetrics = ({ entries, labels, policy }: ComputeMetricsInput): MetricsReport => {
  const labelsByChunk = new Map(labels.map((label) => [label.chunkId, label]));
  const decisions = new Map<string, Extract<JournalEntry, { type: "committed_update" | "no_update" }>>();
  for (const entry of entries) {
    if (entry.type === "committed_update" || entry.type === "no_update") decisions.set(entry.chunkId, entry);
  }

  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  let selectedTopics = 0;
  let falseNoUpdateCount = 0;
  let requiredUpdateCount = 0;
  let bypassCount = 0;
  const byGate: GateMissCounts = { relevance: 0, sameInfo: 0, uncoveredContent: 0 };
  let expectedNewPredictedChanging = 0;
  let expectedChangingPredictedNew = 0;
  let protectedContentLosses = 0;
  let missedCriticalUpdates = 0;

  for (const label of labels) {
    const decision = decisions.get(label.chunkId);
    if (label.requiresUpdate) requiredUpdateCount += 1;
    if (decision?.type === "no_update") bypassCount += 1;
    if (decision?.type === "no_update" && label.requiresUpdate) {
      falseNoUpdateCount += 1;
      if (label.criticalUpdate) missedCriticalUpdates += 1;
      if (label.protectedContent.length > 0) protectedContentLosses += 1;
      if (label.expectedNoUpdateGate === "relevance") byGate.relevance += 1;
      if (label.expectedNoUpdateGate === "same_info") byGate.sameInfo += 1;
      if (label.expectedNoUpdateGate === "uncovered_content") byGate.uncoveredContent += 1;
    }
    const relevance = decision?.classifier?.relevance;
    if (relevance !== undefined) {
      const relevant = new Set(label.relevantTopicIds);
      for (const score of relevance.topics) {
        const selected = score.score >= policy.relevanceThreshold;
        if (selected) selectedTopics += 1;
        if (selected && relevant.has(score.topicId)) truePositive += 1;
        else if (selected) falsePositive += 1;
        else if (relevant.has(score.topicId)) falseNegative += 1;
      }
      for (const topicId of relevant) {
        if (!relevance.topics.some((score) => score.topicId === topicId)) falseNegative += 1;
      }
    } else {
      falseNegative += label.relevantTopicIds.length;
    }
    for (const relation of decision?.classifier?.assessment?.relations ?? []) {
      const expected = label.expectedRelationships[relation.topicId];
      if (expected === "new_info" && relation.relationship === "changing_info")
        expectedNewPredictedChanging += 1;
      if (expected === "changing_info" && relation.relationship === "new_info")
        expectedChangingPredictedNew += 1;
    }
  }

  let equivalent = 0;
  let material = 0;
  let requiredUpdate = 0;
  let writerRegression = 0;
  let inconclusive = 0;
  const humanSpotChecks: MetricsReport["humanSpotChecks"] = [];
  const classifier = emptyRole();
  const writer = emptyRole();
  const evaluator = emptyRole();
  let eligible = 0;
  let sampled = 0;
  let completed = 0;
  let failed = 0;
  let probabilityTotal = 0;
  let potentialWriterCallsShadow = 0;
  let activeBypasses = 0;
  let auditOverheadCalls = 0;

  for (const entry of entries) {
    if (entry.type === "committed_update") {
      addUsage(writer, entry.writerUsage, entry.writerLatencyMs);
      if (entry.classifier?.usage !== undefined)
        addUsage(classifier, entry.classifier.usage, entry.classifier.latencyMs ?? 0, true);
    } else if (entry.type === "no_update") {
      if (entry.classifier.usage !== undefined)
        addUsage(classifier, entry.classifier.usage, entry.classifier.latencyMs ?? 0, true);
    } else if (entry.type === "audit_record" && entry.proposedBypass) {
      eligible += 1;
      probabilityTotal += entry.policy.bypassAuditRate;
      if (entry.policy.mode === "shadow") potentialWriterCallsShadow += 1;
      else activeBypasses += 1;
      if (entry.sampled) {
        sampled += 1;
        auditOverheadCalls += 1;
        if (entry.outcome === "failed" || entry.outcome === "timed_out") failed += 1;
        else completed += 1;
      }
      if (entry.writerUsage !== undefined)
        addUsage(writer, entry.writerUsage, entry.writerLatencyMs ?? 0);
    } else if (entry.type === "semantic_comparison") {
      addUsage(evaluator, entry.evaluatorUsage, entry.evaluatorLatencyMs);
      if (entry.comparison.verdict === "equivalent") equivalent += 1;
      else if (entry.comparison.verdict === "material_change") material += 1;
      if (entry.comparison.changes.some((change) => change.assessment === "required_update"))
        requiredUpdate += 1;
      if (entry.comparison.changes.some((change) => change.assessment === "writer_regression"))
        writerRegression += 1;
      const label = labelsByChunk.get(entry.chunkId);
      if (label?.humanSpotCheck && entry.comparison.verdict !== "uncertain") {
        humanSpotChecks.push({
          chunkId: entry.chunkId,
          fixture: label.file,
          verdict: entry.comparison.verdict,
        });
      }
    } else if (entry.type === "semantic_comparison_failure") {
      inconclusive += 1;
    }
  }
  const agreementDenominator = equivalent + material;
  const confirmedMissDenominator = equivalent + requiredUpdate;
  return {
    fixtures: labels.length,
    relevance: {
      truePositive,
      falsePositive,
      falseNegative,
      recall: ratio(truePositive, truePositive + falseNegative),
      precision: ratio(truePositive, truePositive + falsePositive),
    },
    selectedTopicsPerChunk: labels.length === 0 ? 0 : selectedTopics / labels.length,
    falseNoUpdates: {
      count: falseNoUpdateCount,
      requiredUpdateCount,
      rate: ratio(falseNoUpdateCount, requiredUpdateCount),
      amongBypassesRate: ratio(falseNoUpdateCount, bypassCount),
      byGate,
    },
    newVersusChanging: { expectedNewPredictedChanging, expectedChangingPredictedNew },
    semantic: {
      equivalent,
      material,
      requiredUpdate,
      writerRegression,
      inconclusive,
      agreementDenominator,
      confirmedMissDenominator,
      agreementRate: ratio(equivalent, agreementDenominator),
      confirmedMissRate: ratio(requiredUpdate, confirmedMissDenominator),
    },
    audits: {
      eligible,
      sampled,
      completed,
      failed,
      samplingProbability: ratio(probabilityTotal, eligible),
    },
    model: { classifier, writer, evaluator },
    savings: {
      potentialWriterCallsShadow,
      realizedWriterCallsActive: Math.max(0, activeBypasses - auditOverheadCalls),
      auditOverheadCalls,
    },
    protectedContentLosses,
    missedCriticalUpdates,
    humanSpotChecks,
  };
};
