import { randomUUID } from "node:crypto";
import type {
  Assessment,
  Chunk,
  Classifier,
  ClassifierPolicy,
  Commit,
  DomainError,
  EvaluationJournalEntry,
  Evaluator,
  ExecutionPolicy,
  GateDecisionJournalEntry,
  IngestResult,
  JournalEntryId,
  Memory,
  MemoryPatch,
  ModelIdentifier,
  RelevanceResult,
  Result,
  TaskContext,
  Usage,
  Writer,
} from "../schema";
import {
  AssessmentSchema,
  JournalEntryIdSchema,
  RelevanceResultSchema,
  SemanticComparisonSchema,
} from "../schema";
import { applyPatch } from "./apply_patch";
import { runBaseline } from "./baseline";
import { buildCommit } from "./build_commit";
import { decideRouting, type RoutingDecision } from "./decide_routing";
import {
  DEFAULT_AUDIT_DEADLINE_MS,
  DEFAULT_SHADOW_COMPARISON_DEADLINE_MS,
  DEFAULT_WRITER_DEADLINE_MS,
  modeAction,
  type PipelineMode,
  withDeadline,
} from "./modes";
import { protect } from "./protect";
import { sampleAudit } from "./sample_audit";
import { selectTopics } from "./select_topics";
import { validatePatch } from "./validate_patch";

const hasChanges = (patch: MemoryPatch): boolean =>
  patch.replacements.length > 0 ||
  patch.newTopics.length > 0 ||
  patch.addProtected.length > 0 ||
  patch.supersedeProtected.length > 0;

const message = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

type AdapterCall = {
  provider: string;
  model: string;
  promptVersion: string;
  usage: Usage;
  latencyMs: number;
};

const lastAdapterCall = (adapter: unknown): AdapterCall | undefined => {
  if (
    typeof adapter !== "object" ||
    adapter === null ||
    !("getLastCall" in adapter) ||
    typeof adapter.getLastCall !== "function"
  )
    return undefined;
  const call = adapter.getLastCall();
  if (typeof call !== "object" || call === null) return undefined;
  return call as AdapterCall;
};

const modelIdentifier = (call: AdapterCall): ModelIdentifier => ({
  provider: call.provider,
  model: call.model,
  promptVersion: call.promptVersion,
});

export type IngestDependencies = {
  store: IngestStore;
  classifier: Classifier;
  writer: Writer;
  evaluator?: Evaluator;
  classifierPolicy: ClassifierPolicy;
  executionPolicy?: ExecutionPolicy;
  mode?: "shadow" | "active" | "baseline";
  /** Total active-audit model budget shared by writer and evaluator. */
  auditDeadlineMs?: number;
  /** Evaluation-only budget for comparing an authoritative shadow patch. */
  shadowComparisonDeadlineMs?: number;
  writerDeadlineMs?: number;
  /** Test/replay hook. Production attempts use opaque UUIDs. */
  attemptIdFactory?: () => string;
};

/** Minimal persistence port consumed by orchestration; no store implementation dependency. */
export interface IngestStore {
  archive(chunk: Chunk): Promise<Result<void, DomainError>>;
  load(): Promise<Result<Memory, DomainError>>;
  commit(
    expectedRevision: number,
    change: Commit,
  ): Promise<
    Result<{ status: "committed" | "replayed"; revision: number }, DomainError>
  >;
  appendJournal(
    entry: EvaluationJournalEntry,
  ): Promise<Result<void, DomainError>>;
}

type Classification = {
  relevance?: RelevanceResult;
  assessment?: Assessment;
  routing?: RoutingDecision;
  failure?: {
    gate: GateDecisionJournalEntry["gate"];
    message: string;
  };
};

type AttemptContext = { id: string };

const journalId = (
  chunk: Chunk,
  attempt: AttemptContext,
  suffix: string,
): JournalEntryId =>
  JournalEntryIdSchema.parse(`journal-${chunk.id}-${attempt.id}-${suffix}`);

const effectiveMode = (dependencies: IngestDependencies): PipelineMode =>
  dependencies.mode ?? dependencies.executionPolicy?.mode ?? "shadow";

const executionPolicy = (dependencies: IngestDependencies): ExecutionPolicy => {
  const mode = effectiveMode(dependencies);
  const policy = dependencies.executionPolicy ?? {
    mode: mode === "active" ? "active" : "shadow",
    bypassAuditRate: 0,
    auditSeed: "",
  };
  return mode === "baseline" ? policy : { ...policy, mode };
};

const schemaMessage = (issues: ReadonlyArray<{ message: string }>): string =>
  issues.map(({ message: issue }) => issue).join("; ");

const classify = async (
  chunk: Chunk,
  memory: Memory,
  taskContext: TaskContext,
  classifier: Classifier,
  policy: ClassifierPolicy,
): Promise<Classification> => {
  if (memory.topics.length === 0) {
    return {
      routing: {
        kind: "writer",
        affectedTopicIds: [],
        reason: "empty_catalog",
      },
    };
  }
  try {
    const relevanceResult = RelevanceResultSchema.safeParse(
      await classifier.scoreRelevance({
        chunk,
        taskContext,
        topics: memory.topics.map(({ id, title, description }) => ({
          id,
          title,
          description,
        })),
      }),
    );
    if (!relevanceResult.success) {
      return {
        failure: {
          gate: "classifier",
          message: `malformed relevance response: ${schemaMessage(relevanceResult.error.issues)}`,
        },
      };
    }
    const relevance = relevanceResult.data;
    const selected = selectTopics(memory.topics, relevance, policy);
    if (!selected.ok) {
      return {
        relevance,
        failure: { gate: selected.error.gate, message: selected.error.message },
      };
    }
    const assessmentResult = AssessmentSchema.safeParse(
      await classifier.classifyRelationships({
        chunk,
        taskContext,
        selectedTopics: selected.value,
        topicCatalog: memory.topics.map(({ id, title, description }) => ({
          id,
          title,
          description,
        })),
        protectedRecords: memory.protected,
      }),
    );
    if (!assessmentResult.success) {
      return {
        relevance,
        failure: {
          gate: "classifier",
          message: `malformed relationship response: ${schemaMessage(assessmentResult.error.issues)}`,
        },
      };
    }
    const assessment = assessmentResult.data;
    const routing = decideRouting(selected.value, assessment, policy);
    if (!routing.ok) {
      return {
        relevance,
        assessment,
        failure: { gate: routing.error.gate, message: routing.error.message },
      };
    }
    return { relevance, assessment, routing: routing.value };
  } catch (cause) {
    return { failure: { gate: "classifier", message: message(cause) } };
  }
};

const retained = (chunk: Chunk, reason: string): IngestResult => ({
  status: "retained",
  chunkId: chunk.id,
  reason,
});

const retainAtGate = async (
  dependencies: IngestDependencies,
  attempt: AttemptContext,
  chunk: Chunk,
  memory: Memory,
  gate: GateDecisionJournalEntry["gate"],
  outcome: GateDecisionJournalEntry["outcome"],
  reason: string,
): Promise<IngestResult> => {
  const journaled = await dependencies.store.appendJournal({
    type: "gate_decision",
    id: journalId(chunk, attempt, `gate-${gate}`),
    occurredAt: chunk.createdAt,
    chunkId: chunk.id,
    snapshotRevision: memory.revision,
    gate,
    outcome,
    reason,
    effectiveMode: effectiveMode(dependencies),
    classifierPolicy: dependencies.classifierPolicy,
    executionPolicy: executionPolicy(dependencies),
  });
  if (!journaled.ok)
    return retained(
      chunk,
      `${reason}; journal failed: ${journaled.error.message}`,
    );
  return retained(chunk, reason);
};

type ComparisonFailureOutcome = "timed_out" | "failed" | "invalid_response";

const appendComparisonFailure = async (
  dependencies: IngestDependencies,
  attempt: AttemptContext,
  chunk: Chunk,
  memory: Memory,
  outcome: ComparisonFailureOutcome,
  reason: string,
  suffix = "comparison-failure",
): Promise<void> => {
  try {
    await dependencies.store.appendJournal({
      type: "semantic_comparison_failure",
      id: journalId(chunk, attempt, suffix),
      occurredAt: chunk.createdAt,
      chunkId: chunk.id,
      snapshotRevision: memory.revision,
      outcome,
      reason,
    });
  } catch {
    // A persistent journal outage cannot record its own diagnostic.
  }
};

/** Evaluation-only: every failure is isolated from the authoritative path. */
const appendSemanticComparison = async (
  dependencies: IngestDependencies,
  attempt: AttemptContext,
  chunk: Chunk,
  memory: Memory,
  after: Memory,
  taskContext: TaskContext,
  deadlineMs: number,
): Promise<void> => {
  const evaluator = dependencies.evaluator;
  if (evaluator === undefined) return;
  if (deadlineMs <= 0) {
    await appendComparisonFailure(
      dependencies,
      attempt,
      chunk,
      memory,
      "timed_out",
      "semantic comparison budget exhausted before evaluation",
    );
    return;
  }

  const startedAt = performance.now();
  const operation = Promise.resolve()
    .then(() =>
      evaluator.compare({
        before: structuredClone(memory),
        after: structuredClone(after),
        chunk: structuredClone(chunk),
        taskContext: structuredClone(taskContext),
      }),
    )
    .then(
      (value) => {
        const parsed = SemanticComparisonSchema.safeParse(value);
        return parsed.success
          ? { type: "comparison" as const, value: parsed.data }
          : {
              type: "invalid_response" as const,
              reason: `malformed semantic comparison: ${schemaMessage(parsed.error.issues)}`,
            };
      },
      (cause: unknown) => ({
        type: "failed" as const,
        reason: `semantic comparison failed: ${message(cause)}`,
      }),
    );
  const result = await withDeadline(operation, deadlineMs);
  if (result.status === "timed_out") {
    await appendComparisonFailure(
      dependencies,
      attempt,
      chunk,
      memory,
      "timed_out",
      `semantic comparison timed out after ${deadlineMs}ms`,
    );
    return;
  }
  if (result.value.type !== "comparison") {
    await appendComparisonFailure(
      dependencies,
      attempt,
      chunk,
      memory,
      result.value.type,
      result.value.reason,
    );
    return;
  }
  if (result.value.value.verdict === "uncertain") {
    await appendComparisonFailure(
      dependencies,
      attempt,
      chunk,
      memory,
      "failed",
      "semantic comparison was inconclusive: evaluator returned uncertain",
    );
    return;
  }

  let journaled: Result<void, DomainError>;
  try {
    const evaluatorCall = lastAdapterCall(evaluator);
    journaled = await dependencies.store.appendJournal({
      type: "semantic_comparison",
      id: journalId(chunk, attempt, "comparison"),
      occurredAt: chunk.createdAt,
      chunkId: chunk.id,
      snapshotRevision: memory.revision,
      comparison: result.value.value,
      evaluatorModel:
        evaluatorCall === undefined
          ? {
              provider: "stub",
              model: "deterministic-evaluator",
              promptVersion: "fixture-v1",
            }
          : modelIdentifier(evaluatorCall),
      evaluatorUsage: evaluatorCall?.usage ?? {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      },
      evaluatorLatencyMs:
        evaluatorCall?.latencyMs ?? Math.max(0, performance.now() - startedAt),
    });
  } catch (cause) {
    await appendComparisonFailure(
      dependencies,
      attempt,
      chunk,
      memory,
      "failed",
      `semantic comparison journal failed: ${message(cause)}`,
      "comparison-journal-failure",
    );
    return;
  }
  if (!journaled.ok) {
    await appendComparisonFailure(
      dependencies,
      attempt,
      chunk,
      memory,
      "failed",
      `semantic comparison journal failed: ${journaled.error.message}`,
      "comparison-journal-failure",
    );
  }
};

const appendAudit = async (
  dependencies: IngestDependencies,
  attempt: AttemptContext,
  chunk: Chunk,
  memory: Memory,
  taskContext: TaskContext,
  sampled: boolean,
): Promise<string | undefined> => {
  const policy = executionPolicy(dependencies);
  const auditStartedAt = performance.now();
  let outcome:
    | "not_sampled"
    | "empty_patch"
    | "patch"
    | "failed"
    | "timed_out" = "not_sampled";
  let patch: MemoryPatch | undefined;
  if (sampled) {
    const deadline = dependencies.auditDeadlineMs ?? DEFAULT_AUDIT_DEADLINE_MS;
    const result = await withDeadline(
      Promise.resolve()
        .then(() =>
          dependencies.writer.propose({
            chunk,
            memory: structuredClone(memory),
            taskContext,
            affectedTopicIds: memory.topics.map(({ id }) => id),
          }),
        )
        .then((value) => ({ type: "patch" as const, value }))
        .catch(() => ({ type: "failed" as const })),
      deadline,
    );
    if (result.status === "timed_out") outcome = "timed_out";
    else {
      if (result.value.type === "failed") outcome = "failed";
      else {
        const valid = validatePatch(memory, chunk, result.value.value);
        if (!valid.ok) outcome = "failed";
        else {
          patch = valid.value;
          outcome = hasChanges(patch) ? "patch" : "empty_patch";
        }
      }
    }
  }
  const auditWriterCall = lastAdapterCall(dependencies.writer);
  const journaled = await dependencies.store.appendJournal({
    type: "audit_record",
    id: journalId(chunk, attempt, "audit"),
    occurredAt: chunk.createdAt,
    chunkId: chunk.id,
    snapshotRevision: memory.revision,
    policy,
    sampled,
    proposedBypass: true,
    outcome,
    ...(patch === undefined ? {} : { patch }),
    ...(auditWriterCall === undefined
      ? {}
      : {
          writerModel: modelIdentifier(auditWriterCall),
          writerUsage: auditWriterCall.usage,
          writerLatencyMs: auditWriterCall.latencyMs,
        }),
  });
  if (!journaled.ok) return `audit journal failed: ${journaled.error.message}`;

  if (patch !== undefined && hasChanges(patch)) {
    const deadline = dependencies.auditDeadlineMs ?? DEFAULT_AUDIT_DEADLINE_MS;
    const remainingMs = Math.max(
      0,
      deadline - (performance.now() - auditStartedAt),
    );
    await appendSemanticComparison(
      dependencies,
      attempt,
      chunk,
      memory,
      applyPatch(memory, patch),
      taskContext,
      remainingMs,
    );
  }
  return undefined;
};

export const ingest = async (
  chunk: Chunk,
  taskContext: TaskContext,
  dependencies: IngestDependencies,
): Promise<IngestResult> => {
  const archived = await dependencies.store.archive(chunk);
  if (!archived.ok)
    return retained(chunk, `archive failed: ${archived.error.message}`);
  const loaded = await dependencies.store.load();
  if (!loaded.ok)
    return retained(chunk, `load failed: ${loaded.error.message}`);
  const memory = loaded.value;
  if (memory.processedChunkIds.includes(chunk.id)) {
    return { status: "replayed", chunkId: chunk.id, revision: memory.revision };
  }
  const attempt = {
    id: dependencies.attemptIdFactory?.() ?? randomUUID(),
  };
  const mode = effectiveMode(dependencies);
  if (
    dependencies.mode !== undefined &&
    dependencies.mode !== "baseline" &&
    dependencies.executionPolicy !== undefined &&
    dependencies.executionPolicy.mode !== dependencies.mode
  ) {
    return retainAtGate(
      dependencies,
      attempt,
      chunk,
      memory,
      "configuration",
      "failure",
      `mode ${dependencies.mode} conflicts with execution policy mode ${dependencies.executionPolicy.mode}`,
    );
  }
  const protectedResult = protect(chunk);
  if (!protectedResult.ok) {
    return retainAtGate(
      dependencies,
      attempt,
      chunk,
      memory,
      "protect",
      "failure",
      protectedResult.error.message,
    );
  }
  const classification =
    mode === "baseline"
      ? {
          routing: {
            kind: "writer",
            affectedTopicIds: memory.topics.map(({ id }) => id),
            reason: "baseline",
          } as RoutingDecision,
        }
      : await classify(
          chunk,
          memory,
          taskContext,
          dependencies.classifier,
          dependencies.classifierPolicy,
        );
  if (mode === "active" && classification.failure !== undefined) {
    return retainAtGate(
      dependencies,
      attempt,
      chunk,
      memory,
      classification.failure.gate,
      "escalation",
      `classifier escalation: ${classification.failure.message}`,
    );
  }
  const proposedShadowBypass =
    mode === "shadow" && classification.routing?.kind === "bypass";
  if (proposedShadowBypass) {
    const journaled = await dependencies.store.appendJournal({
      type: "audit_record",
      id: journalId(chunk, attempt, "shadow-routing"),
      occurredAt: chunk.createdAt,
      chunkId: chunk.id,
      snapshotRevision: memory.revision,
      policy: executionPolicy(dependencies),
      sampled: false,
      proposedBypass: true,
      outcome: "not_sampled",
    });
    if (!journaled.ok)
      return retained(
        chunk,
        `shadow routing journal failed: ${journaled.error.message}`,
      );
  }

  const forcedWriter = protectedResult.value.length > 0;
  const action = forcedWriter
    ? "writer"
    : modeAction(mode, classification.routing);
  if (action === "bypass") {
    const policy = executionPolicy(dependencies);
    const sampled = sampleAudit(
      chunk.id,
      policy.auditSeed,
      policy.bypassAuditRate,
    );
    const auditFailure = await appendAudit(
      dependencies,
      attempt,
      chunk,
      memory,
      taskContext,
      sampled,
    );
    if (auditFailure !== undefined) return retained(chunk, auditFailure);
    const commit = buildCommit(memory, undefined, chunk, undefined, {
      ...(classification.relevance === undefined
        ? {}
        : { relevance: classification.relevance }),
      ...(classification.assessment === undefined
        ? {}
        : { assessment: classification.assessment }),
      reason: `${classification.routing?.reason ?? "bypass"}; policy=${JSON.stringify(dependencies.classifierPolicy)}`,
    });
    const result = await dependencies.store.commit(memory.revision, commit);
    if (!result.ok)
      return retained(chunk, `commit failed: ${result.error.message}`);
    return result.value.status === "replayed"
      ? {
          status: "replayed",
          chunkId: chunk.id,
          revision: result.value.revision,
        }
      : {
          status: "no_update",
          chunkId: chunk.id,
          revision: result.value.revision,
        };
  }

  const writerDeadline =
    dependencies.writerDeadlineMs ?? DEFAULT_WRITER_DEADLINE_MS;
  const proposalResult = await withDeadline(
    Promise.resolve()
      .then(() =>
        mode === "baseline"
          ? runBaseline(
              dependencies.writer,
              chunk,
              structuredClone(memory),
              taskContext,
            )
          : dependencies.writer.propose({
              chunk,
              memory: structuredClone(memory),
              taskContext,
              affectedTopicIds:
                mode === "shadow"
                  ? memory.topics.map(({ id }) => id)
                  : (classification.routing?.affectedTopicIds ?? []),
              ...(mode === "active" && classification.assessment !== undefined
                ? { assessment: classification.assessment }
                : {}),
            }),
      )
      .then((value) => ({ type: "patch" as const, value }))
      .catch((cause: unknown) => ({ type: "failed" as const, cause })),
    writerDeadline,
  );
  if (proposalResult.status === "timed_out") {
    return retainAtGate(
      dependencies,
      attempt,
      chunk,
      memory,
      "writer",
      "failure",
      `writer timed out after ${writerDeadline}ms`,
    );
  }
  if (proposalResult.value.type === "failed") {
    return retainAtGate(
      dependencies,
      attempt,
      chunk,
      memory,
      "writer",
      "failure",
      `writer failed: ${message(proposalResult.value.cause)}`,
    );
  }
  const proposed = proposalResult.value.value;
  const proposedValid = validatePatch(memory, chunk, proposed);
  if (!proposedValid.ok) {
    return retainAtGate(
      dependencies,
      attempt,
      chunk,
      memory,
      proposedValid.error.gate,
      "escalation",
      `patch escalation: ${proposedValid.error.message}`,
    );
  }
  const deterministicIds = new Set(
    protectedResult.value.map(({ id }) => String(id)),
  );
  const protectedCollision = proposedValid.value.addProtected.find(({ id }) =>
    deterministicIds.has(id),
  );
  if (protectedCollision !== undefined) {
    return retainAtGate(
      dependencies,
      attempt,
      chunk,
      memory,
      "patch",
      "escalation",
      `patch escalation: writer protected record collides with deterministic protection: ${protectedCollision.id}`,
    );
  }
  const merged: MemoryPatch = {
    ...proposedValid.value,
    addProtected: [
      ...protectedResult.value,
      ...proposedValid.value.addProtected,
    ],
  };
  const valid = validatePatch(memory, chunk, merged);
  if (!valid.ok) {
    return retainAtGate(
      dependencies,
      attempt,
      chunk,
      memory,
      valid.error.gate,
      "escalation",
      `patch escalation: ${valid.error.message}`,
    );
  }
  const changed = hasChanges(valid.value);
  const after = changed ? applyPatch(memory, valid.value, chunk.id) : undefined;
  const writerCall = lastAdapterCall(dependencies.writer);
  const commit = buildCommit(
    memory,
    after,
    chunk,
    changed ? valid.value : undefined,
    {
      ...(classification.relevance === undefined
        ? {}
        : { relevance: classification.relevance }),
      ...(classification.assessment === undefined
        ? {}
        : { assessment: classification.assessment }),
      reason:
        classification.failure !== undefined
          ? `classifier unavailable: ${classification.failure.message}`
          : changed
            ? (classification.routing?.reason ?? "writer")
            : `${classification.routing?.reason ?? "writer"}; writer returned empty patch`,
      ...(writerCall === undefined
        ? {}
        : {
            writerModel: modelIdentifier(writerCall),
            writerUsage: writerCall.usage,
            writerLatencyMs: writerCall.latencyMs,
          }),
    },
  );
  const result = await dependencies.store.commit(memory.revision, commit);
  if (!result.ok)
    return retained(chunk, `commit failed: ${result.error.message}`);
  if (result.value.status === "replayed")
    return {
      status: "replayed",
      chunkId: chunk.id,
      revision: result.value.revision,
    };
  if (proposedShadowBypass && changed && after !== undefined) {
    await appendSemanticComparison(
      dependencies,
      attempt,
      chunk,
      memory,
      after,
      taskContext,
      dependencies.shadowComparisonDeadlineMs ??
        DEFAULT_SHADOW_COMPARISON_DEADLINE_MS,
    );
  }
  return changed
    ? {
        status: "committed",
        chunkId: chunk.id,
        revision: result.value.revision,
      }
    : {
        status: "no_update",
        chunkId: chunk.id,
        revision: result.value.revision,
      };
};

export class CompactPipeline {
  constructor(readonly dependencies: IngestDependencies) {}

  ingest(chunk: Chunk, taskContext: TaskContext): Promise<IngestResult> {
    return ingest(chunk, taskContext, this.dependencies);
  }
}
