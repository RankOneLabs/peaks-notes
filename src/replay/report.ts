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
    `Gate misses: relevance=${report.falseNoUpdates.byGate.relevance}, same-info=${report.falseNoUpdates.byGate.sameInfo}, uncovered=${report.falseNoUpdates.byGate.uncoveredContent}`,
    `Protected-content losses: ${report.protectedContentLosses}`,
    `Missed critical updates: ${report.missedCriticalUpdates}`,
    `Semantic: equivalent=${report.semantic.equivalent}, material=${report.semantic.material}, required-update=${report.semantic.requiredUpdate}, writer-regression=${report.semantic.writerRegression}, inconclusive=${report.semantic.inconclusive}`,
    `Audits: eligible=${report.audits.eligible}, sampled=${report.audits.sampled}, completed=${report.audits.completed}, failed=${report.audits.failed}, probability=${percent(report.audits.samplingProbability)}`,
    `Writer savings: shadow-potential=${report.savings.potentialWriterCallsShadow}, active-realized=${report.savings.realizedWriterCallsActive}, audit-overhead=${report.savings.auditOverheadCalls}`,
    `Tokens: classifier=${report.model.classifier.totalTokens}, writer=${report.model.writer.totalTokens}, evaluator=${report.model.evaluator.totalTokens}`,
    `Latency ms: classifier=${report.model.classifier.latencyMs.toFixed(1)}, writer=${report.model.writer.latencyMs.toFixed(1)}, evaluator=${report.model.evaluator.latencyMs.toFixed(1)}`,
    `Jev input cost USD: ${report.model.classifier.costUsd.toFixed(8)}`,
    "Human spot checks:",
    ...(report.humanSpotChecks.length === 0
      ? ["  none"]
      : report.humanSpotChecks.map(
          ({ fixture, chunkId, verdict }) => `  ${fixture} (${chunkId}): ${verdict}`,
        )),
  ].join("\n");
