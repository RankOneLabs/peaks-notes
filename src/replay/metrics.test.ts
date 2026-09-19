import { expect, test } from "bun:test";
import type { JournalEntry } from "../schema";
import type { FixtureLabel } from "./load_fixtures";
import { computeMetrics } from "./metrics";
import { formatReport } from "./report";

const policy = {
  relevanceThreshold: 0.5,
  sameInfoMinConfidence: 0.8,
  uncoveredNoChangeMinConfidence: 0.8,
};

const label = (
  chunkId: string,
  gate: FixtureLabel["expectedNoUpdateGate"],
): FixtureLabel => ({
  file: `fixtures/deterministic/${chunkId}.json`,
  chunkId,
  requiredCases: ["equivalent_restatement"],
  relevantTopicIds: ["topic-a"],
  expectedRelationships: {},
  requiresUpdate: true,
  criticalUpdate: false,
  expectedNoUpdateGate: gate,
  protectedContent: [],
  humanSpotCheck: false,
});

const noUpdate = (chunkId: string): JournalEntry => ({
  type: "no_update",
  id: `journal-${chunkId}` as never,
  occurredAt: "2026-09-18T00:00:00.000Z",
  chunkId: chunkId as never,
  snapshotRevision: 1,
  previousRevision: 1,
  newRevision: 1,
  classifier: {
    relevance: { topics: [{ topicId: "topic-a" as never, score: 0.1 }] },
    assessment: {
      relations: [],
      uncovered: { outcome: "none", confidence: 0.99 },
    },
  },
  reason: "fixture bypass",
});

test("one labeled miss at every gate is counted independently", () => {
  const labels = [
    label("miss-relevance", "relevance"),
    label("miss-same-info", "same_info"),
    label("miss-uncovered", "uncovered_content"),
  ];
  const report = computeMetrics({
    entries: labels.map(({ chunkId }) => noUpdate(chunkId)),
    labels,
    policy,
  });
  expect(report.falseNoUpdates.byGate).toEqual({
    relevance: 1,
    sameInfo: 1,
    uncoveredContent: 1,
  });
});

test("formatted report includes bypass and relationship confusion metrics", () => {
  const labels = [label("miss-relevance", "relevance")];
  const report = formatReport(
    computeMetrics({ entries: [noUpdate("miss-relevance")], labels, policy }),
  );
  expect(report).toContain("False no-updates among bypasses: 100.00%");
  expect(report).toContain(
    "New-versus-changing confusion: expected-new/predicted-changing=0, expected-changing/predicted-new=0",
  );
});

test("inconclusive comparisons are outside agreement and miss denominators", () => {
  const base = {
    occurredAt: "2026-09-18T00:00:00.000Z",
    chunkId: "chunk-a" as never,
    snapshotRevision: 1,
  };
  const entries: JournalEntry[] = [
    {
      ...base,
      type: "semantic_comparison",
      id: "journal-equivalent" as never,
      comparison: { verdict: "equivalent", changes: [] },
      evaluatorModel: { provider: "stub", model: "eval", promptVersion: "v1" },
      evaluatorUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      evaluatorLatencyMs: 2,
    },
    {
      ...base,
      type: "semantic_comparison_failure",
      id: "journal-failure" as never,
      outcome: "failed",
      reason: "uncertain",
    },
  ];
  const report = computeMetrics({ entries, labels: [], policy });
  expect(report.semantic).toMatchObject({
    equivalent: 1,
    inconclusive: 1,
    agreementDenominator: 1,
    confirmedMissDenominator: 1,
  });
});

test("canonical call events count each provider request without aggregate duplication", () => {
  const base = {
    occurredAt: "2026-09-18T00:00:00.000Z",
    chunkId: "chunk-calls" as never,
    snapshotRevision: 0,
    attemptId: "attempt-calls",
  };
  const calls: JournalEntry[] = [
    ["relevance", 3],
    ["relationships", 5],
  ].map(([operation, inputTokens], index) => ({
    ...base,
    type: "model_call" as const,
    id: `journal-call-${index}` as never,
    callId: `call-${index}`,
    role: "classifier" as const,
    operation: operation as "relevance" | "relationships",
    status: "succeeded" as const,
    provider: "typesafe",
    model: "jev-1.13.0",
    promptVersion: "v1",
    latencyMs: 2,
    usage: {
      inputTokens: inputTokens as number,
      outputTokens: 1,
      totalTokens: (inputTokens as number) + 1,
    },
    usageProvenance: "reported" as const,
  }));
  const report = computeMetrics({ entries: calls, labels: [], policy });
  expect(report.model.classifier).toMatchObject({
    calls: 2,
    inputTokens: 8,
    outputTokens: 2,
    totalTokens: 10,
  });
});

test("canonical call suppression is scoped by role, chunk, and attempt", () => {
  const occurredAt = "2026-09-18T00:00:00.000Z";
  const entries: JournalEntry[] = [
    {
      type: "model_call",
      id: "journal-canonical-writer" as never,
      occurredAt,
      chunkId: "chunk-a" as never,
      snapshotRevision: 0,
      attemptId: "attempt-a",
      callId: "call-writer-a",
      role: "writer",
      operation: "propose",
      status: "succeeded",
      provider: "openai",
      model: "writer",
      promptVersion: "v1",
      latencyMs: 2,
      usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 },
      usageProvenance: "reported",
    },
    {
      type: "audit_record",
      id: "journal-matching-aggregate" as never,
      occurredAt,
      chunkId: "chunk-a" as never,
      snapshotRevision: 0,
      attemptId: "attempt-a",
      policy: { mode: "active", bypassAuditRate: 1, auditSeed: "seed" },
      sampled: true,
      proposedBypass: true,
      outcome: "empty_patch",
      writerUsage: { inputTokens: 30, outputTokens: 10, totalTokens: 40 },
      writerLatencyMs: 20,
    },
    {
      type: "audit_record",
      id: "journal-other-attempt-aggregate" as never,
      occurredAt,
      chunkId: "chunk-b" as never,
      snapshotRevision: 0,
      attemptId: "attempt-b",
      policy: { mode: "active", bypassAuditRate: 1, auditSeed: "seed" },
      sampled: true,
      proposedBypass: true,
      outcome: "empty_patch",
      writerUsage: { inputTokens: 5, outputTokens: 1, totalTokens: 6 },
      writerLatencyMs: 3,
    },
    {
      type: "semantic_comparison",
      id: "journal-legacy-evaluator" as never,
      occurredAt,
      chunkId: "chunk-legacy" as never,
      snapshotRevision: 0,
      comparison: { verdict: "equivalent", changes: [] },
      evaluatorModel: {
        provider: "openai",
        model: "eval",
        promptVersion: "v1",
      },
      evaluatorUsage: { inputTokens: 7, outputTokens: 1, totalTokens: 8 },
      evaluatorLatencyMs: 4,
    },
  ];

  const report = computeMetrics({ entries, labels: [], policy });
  expect(report.model.writer).toMatchObject({
    calls: 2,
    inputTokens: 8,
    outputTokens: 2,
    totalTokens: 10,
  });
  expect(report.model.evaluator).toMatchObject({
    calls: 1,
    totalTokens: 8,
  });
});

test("shadow bypass predictions are excluded from eligible audits and sampling probability", () => {
  const base = {
    occurredAt: "2026-09-18T00:00:00.000Z",
    snapshotRevision: 0,
  };
  const activeAudit = (chunkId: string): JournalEntry => ({
    ...base,
    type: "audit_record",
    id: `journal-${chunkId}` as never,
    chunkId: chunkId as never,
    policy: { mode: "active", bypassAuditRate: 1, auditSeed: "seed" },
    sampled: true,
    proposedBypass: true,
    outcome: "empty_patch",
  });
  const shadowAudit = (chunkId: string): JournalEntry => ({
    ...base,
    type: "audit_record",
    id: `journal-${chunkId}` as never,
    chunkId: chunkId as never,
    policy: { mode: "shadow", bypassAuditRate: 1, auditSeed: "seed" },
    sampled: false,
    proposedBypass: true,
    outcome: "not_sampled",
  });
  const entries: JournalEntry[] = [
    activeAudit("chunk-a"),
    activeAudit("chunk-b"),
    activeAudit("chunk-c"),
    activeAudit("chunk-d"),
    shadowAudit("chunk-e"),
    shadowAudit("chunk-f"),
  ];
  const report = computeMetrics({ entries, labels: [], policy });
  expect(report.audits).toMatchObject({
    eligible: 4,
    samplingProbability: 1,
  });
  expect(report.savings.potentialWriterCallsShadow).toBe(2);
  expect(formatReport(report)).toContain("shadow-predictions=2");
});

test("route-less journals retain legacy classifier-policy behavior", () => {
  const labels = [label("legacy-no-update", "relevance")];
  const report = computeMetrics({
    entries: [noUpdate("legacy-no-update")],
    labels,
    policy,
  });

  expect(report.classifierPolicy).toBeUndefined();
  expect(formatReport(report)).toContain(
    "Classifier-policy coverage: unavailable for legacy journal",
  );
});
