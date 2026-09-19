import type { MetricsReport } from "./metrics";

const percent = (value: number | null): string =>
  value === null ? "n/a" : `${(value * 100).toFixed(2)}%`;

export const formatReport = (report: MetricsReport): string =>
  [
    "Replay metrics",
    `Fixtures: ${report.fixtures}`,
    `Relevance recall / precision: ${percent(report.relevance.recall)} / ${percent(report.relevance.precision)}`,
    `Selected topics per chunk: ${report.selectedTopicsPerChunk.toFixed(2)}`,
    `False no-updates: ${report.falseNoUpdates.count}/${report.falseNoUpdates.requiredUpdateCount} (${percent(report.falseNoUpdates.rate)})`,
    `False no-updates among bypasses: ${percent(report.falseNoUpdates.amongBypassesRate)}`,
    `Gate misses: relevance=${report.falseNoUpdates.byGate.relevance}, same-info=${report.falseNoUpdates.byGate.sameInfo}, uncovered=${report.falseNoUpdates.byGate.uncoveredContent}`,
    ...(report.classifierPolicy === undefined
      ? ["Classifier-policy coverage: unavailable for legacy journal"]
      : [
          `Classifier policy: evaluated=${report.classifierPolicy.evaluatedLabeled}/${report.classifierPolicy.eligibleLabeled}, bypasses=${report.classifierPolicy.predictedBypasses}, required-update-misses=${report.classifierPolicy.requiredUpdatesPredictedBypass}, critical-misses=${report.classifierPolicy.criticalMisses}, unavailable=${report.classifierPolicy.unavailable}`,
        ]),
    ...(report.authoritative === undefined
      ? []
      : [
          `Authoritative outcomes: active-bypasses=${report.authoritative.activeBypasses}, writer-no-updates=${report.authoritative.writerReviewedNoUpdates}, updates=${report.authoritative.committedUpdates}, retained=${report.authoritative.retainedFailures}, budget-failures=${report.authoritative.budgetFailures}`,
        ]),
    `New-versus-changing confusion: expected-new/predicted-changing=${report.newVersusChanging.expectedNewPredictedChanging}, expected-changing/predicted-new=${report.newVersusChanging.expectedChangingPredictedNew}`,
    `Protected-content losses: ${report.protectedContentLosses}`,
    `Missed critical updates: ${report.missedCriticalUpdates}`,
    `Semantic: equivalent=${report.semantic.equivalent}, material=${report.semantic.material}, required-update=${report.semantic.requiredUpdate}, writer-regression=${report.semantic.writerRegression}, inconclusive=${report.semantic.inconclusive}`,
    `Audits: eligible=${report.audits.eligible}, sampled=${report.audits.sampled}, completed=${report.audits.completed}, failed=${report.audits.failed}, timed-out=${report.audits.timedOut} (${percent(report.audits.sampled === 0 ? 0 : report.audits.timedOut / report.audits.sampled)} of sampled), probability=${percent(report.audits.samplingProbability)}, shadow-predictions=${report.savings.potentialWriterCallsShadow}`,
    `Writer savings: shadow-potential=${report.savings.potentialWriterCallsShadow}, active-realized=${report.savings.realizedWriterCallsActive}, audit-overhead=${report.savings.auditOverheadCalls}`,
    `Tokens: classifier=${report.model.classifier.totalTokens}, writer=${report.model.writer.totalTokens}, evaluator=${report.model.evaluator.totalTokens}`,
    `Latency ms: classifier=${report.model.classifier.latencyMs.toFixed(1)}, writer=${report.model.writer.latencyMs.toFixed(1)}, evaluator=${report.model.evaluator.latencyMs.toFixed(1)}`,
    `Usage coverage: classifier reported=${report.model.classifier.reportedUsageCalls ?? 0} estimated=${report.model.classifier.estimatedUsageCalls ?? 0} unknown=${report.model.classifier.unknownUsageCalls ?? 0}; writer reported=${report.model.writer.reportedUsageCalls ?? 0} estimated=${report.model.writer.estimatedUsageCalls ?? 0} unknown=${report.model.writer.unknownUsageCalls ?? 0}; evaluator reported=${report.model.evaluator.reportedUsageCalls ?? 0} estimated=${report.model.evaluator.estimatedUsageCalls ?? 0} unknown=${report.model.evaluator.unknownUsageCalls ?? 0}`,
    `Jev input cost USD: ${report.model.classifier.costUsd.toFixed(8)}`,
    "Human spot checks:",
    ...(report.humanSpotChecks.length === 0
      ? ["  none"]
      : report.humanSpotChecks.map(
          ({ fixture, chunkId, verdict }) =>
            `  ${fixture} (${chunkId}): ${verdict}`,
        )),
  ].join("\n");
