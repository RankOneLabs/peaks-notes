import { randomUUID } from "node:crypto";
import { z } from "zod";
import { assembleContext } from "../render/context";
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
  Message,
  ModelIdentifier,
  RelevanceResult,
  Result,
  TaskContext,
  Tokenizer,
  Usage,
  Writer,
} from "../schema";
import {
  AssessmentSchema,
  JournalEntryIdSchema,
  ModelIdentifierSchema,
  RelevanceResultSchema,
  SemanticComparisonSchema,
  UsageSchema,
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
import { validateCompressionPatch, validatePatch } from "./validate_patch";

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
  dispatched?: boolean | undefined;
  usageProvenance?: "reported" | "estimated" | "unknown" | undefined;
};

const AdapterCallSchema = ModelIdentifierSchema.extend({
  provider: z.string().min(1),
  model: z.string().min(1),
  promptVersion: z.string().min(1),
  usage: UsageSchema.refine(
    (usage) => usage.totalTokens === usage.inputTokens + usage.outputTokens,
    { message: "totalTokens must equal inputTokens plus outputTokens" },
  ),
  latencyMs: z.number().nonnegative(),
  dispatched: z.boolean().optional(),
  usageProvenance: z.enum(["reported", "estimated", "unknown"]).optional(),
}).strict();

const lastAdapterCall = (adapter: unknown): AdapterCall | undefined => {
  if (
    typeof adapter !== "object" ||
    adapter === null ||
    !("getLastCall" in adapter) ||
    typeof adapter.getLastCall !== "function"
  )
    return undefined;
  const parsed = AdapterCallSchema.safeParse(adapter.getLastCall());
  return parsed.success ? parsed.data : undefined;
};

const adapterCallFor = (
  adapter: unknown,
  result: object,
): AdapterCall | undefined => {
  if (
    typeof adapter === "object" &&
    adapter !== null &&
    "getCallFor" in adapter &&
    typeof adapter.getCallFor === "function"
  ) {
    const parsed = AdapterCallSchema.safeParse(adapter.getCallFor(result));
    return parsed.success ? parsed.data : undefined;
  }
  return undefined;
};

const modelIdentifier = (call: AdapterCall): ModelIdentifier => ({
  provider: call.provider,
  model: call.model,
  promptVersion: call.promptVersion,
});

type JevTrace = {
  operation: "relevance" | "relationships";
  model: string;
  requests: unknown[];
  requestUsage: Array<{
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
  }>;
  requestStatuses?: Array<"succeeded" | "failed" | "timed_out">;
};

const drainClassifierCalls = (classifier: unknown): JevTrace[] => {
  if (
    typeof classifier !== "object" ||
    classifier === null ||
    !("drainCalls" in classifier) ||
    typeof classifier.drainCalls !== "function"
  )
    return [];
  const calls = classifier.drainCalls();
  return Array.isArray(calls) ? (calls as JevTrace[]) : [];
};

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
  /** Host context remaining after this commit; raw messages must include retained failures. */
  /** Required by production callers. Optional only for backward-compatible test harnesses. */
  budget?: IngestBudgetContext;
  /** Test/replay hook. Production attempts use opaque UUIDs. */
  attemptIdFactory?: () => string;
};

export type IngestBudgetContext = {
  maxTokens: number;
  summaryBudgetTokens: number;
  tokenizer: Tokenizer;
  rawMessages: readonly Message[];
  retainedFailures?: readonly Message[];
  recentMessageCount?: number;
  compressionDeadlineMs?: number;
};

export type PipelineDependencies = IngestDependencies & {
  budget: IngestBudgetContext;
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

const appendClassifierCalls = async (
  dependencies: IngestDependencies,
  attempt: AttemptContext,
  chunk: Chunk,
  memory: Memory,
): Promise<string | undefined> => {
  const traces = drainClassifierCalls(dependencies.classifier);
  let ordinal = 0;
  for (const trace of traces) {
    for (const [requestIndex, usage] of trace.requestUsage.entries()) {
      ordinal += 1;
      const result = await dependencies.store.appendJournal({
        type: "model_call",
        id: journalId(chunk, attempt, `model-classifier-${ordinal}`),
        occurredAt: chunk.createdAt,
        chunkId: chunk.id,
        snapshotRevision: memory.revision,
        attemptId: attempt.id,
        callId: `${chunk.id}:${attempt.id}:classifier:${ordinal}`,
        role: "classifier",
        operation: trace.operation,
        status: trace.requestStatuses?.[requestIndex] ?? "succeeded",
        provider: "typesafe",
        model: trace.model,
        promptVersion:
          trace.operation === "relationships"
            ? "relationship-v2"
            : "relevance-v1",
        latencyMs: usage.latencyMs,
        usage: {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          totalTokens: usage.inputTokens + usage.outputTokens,
        },
        usageProvenance:
          (trace.requestStatuses?.[requestIndex] ?? "succeeded") === "succeeded"
            ? "reported"
            : "unknown",
        requestIndex,
      });
      if (!result.ok) return result.error.message;
    }
  }
  return undefined;
};

const appendAdapterCall = async (
  dependencies: IngestDependencies,
  attempt: AttemptContext,
  chunk: Chunk,
  memory: Memory,
  role: "writer" | "evaluator",
  operation: "propose" | "compress" | "compare",
  call: AdapterCall | undefined,
  status: "succeeded" | "failed" | "timed_out" = "succeeded",
): Promise<string | undefined> => {
  if (call === undefined) return undefined;
  if (call.dispatched === false) return undefined;
  if (
    operation === "compare" &&
    call.usage.totalTokens === 0 &&
    call.latencyMs === 0
  )
    return undefined;
  const suffix = `model-${role}-${operation}`;
  const result = await dependencies.store.appendJournal({
    type: "model_call",
    id: journalId(chunk, attempt, suffix),
    occurredAt: chunk.createdAt,
    chunkId: chunk.id,
    snapshotRevision: memory.revision,
    attemptId: attempt.id,
    callId: `${chunk.id}:${attempt.id}:${role}:${operation}`,
    role,
    operation,
    status,
    provider: call.provider,
    model: call.model,
    promptVersion: call.promptVersion,
    latencyMs: call.latencyMs,
    ...(call.usageProvenance === "unknown" ? {} : { usage: call.usage }),
    usageProvenance: call.usageProvenance ?? "reported",
  });
  return result.ok ? undefined : result.error.message;
};

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
    attemptId: attempt.id,
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
      attemptId: attempt.id,
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
        const evaluatorCall = adapterCallFor(evaluator, value);
        const parsed = SemanticComparisonSchema.safeParse(value);
        return parsed.success
          ? {
              type: "comparison" as const,
              value: parsed.data,
              evaluatorCall,
            }
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
    const evaluatorCall = result.value.evaluatorCall;
    const callFailure = await appendAdapterCall(
      dependencies,
      attempt,
      chunk,
      memory,
      "evaluator",
      "compare",
      evaluatorCall,
    );
    if (callFailure !== undefined) {
      await appendComparisonFailure(
        dependencies,
        attempt,
        chunk,
        memory,
        "failed",
        `evaluator call journal failed: ${callFailure}`,
        "comparison-call-journal-failure",
      );
      return;
    }
    journaled = await dependencies.store.appendJournal({
      type: "semantic_comparison",
      id: journalId(chunk, attempt, "comparison"),
      occurredAt: chunk.createdAt,
      chunkId: chunk.id,
      snapshotRevision: memory.revision,
      attemptId: attempt.id,
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
  let auditWriterCall: AdapterCall | undefined;
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
        .then((value) => ({
          type: "patch" as const,
          value,
          writerCall: adapterCallFor(dependencies.writer, value),
        }))
        .catch(() => ({ type: "failed" as const })),
      deadline,
    );
    if (result.status === "timed_out") outcome = "timed_out";
    else {
      if (result.value.type === "failed") outcome = "failed";
      else {
        auditWriterCall = result.value.writerCall;
        const valid = validatePatch(memory, chunk, result.value.value);
        if (!valid.ok) outcome = "failed";
        else {
          if (!hasChanges(valid.value)) {
            patch = valid.value;
            outcome = "empty_patch";
          } else {
            const remainingMs = Math.max(
              1,
              deadline - (performance.now() - auditStartedAt),
            );
            const prepared = await prepareWithinBudget(
              memory,
              valid.value,
              taskContext,
              dependencies.budget === undefined
                ? dependencies
                : {
                    ...dependencies,
                    budget: {
                      ...dependencies.budget,
                      compressionDeadlineMs: remainingMs,
                    },
                  },
            );
            if (prepared.compressed) {
              const callFailure = await appendAdapterCall(
                dependencies,
                attempt,
                chunk,
                memory,
                "writer",
                "compress",
                lastAdapterCall(dependencies.writer),
                prepared.status === "failed" ? "failed" : "succeeded",
              );
              if (callFailure !== undefined)
                return `audit compression journal failed: ${callFailure}`;
            }
            if (prepared.status === "ready") {
              patch = prepared.patch;
              outcome = "patch";
            } else outcome = "failed";
          }
        }
      }
    }
  }
  const auditCallFailure = await appendAdapterCall(
    dependencies,
    attempt,
    chunk,
    memory,
    "writer",
    "propose",
    auditWriterCall,
    outcome === "timed_out"
      ? "timed_out"
      : outcome === "failed"
        ? "failed"
        : "succeeded",
  );
  if (auditCallFailure !== undefined)
    return `audit writer call journal failed: ${auditCallFailure}`;
  const journaled = await dependencies.store.appendJournal({
    type: "audit_record",
    id: journalId(chunk, attempt, "audit"),
    occurredAt: chunk.createdAt,
    chunkId: chunk.id,
    snapshotRevision: memory.revision,
    attemptId: attempt.id,
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

type BudgetPreparation =
  | { status: "ready"; memory: Memory; patch: MemoryPatch; compressed: boolean }
  | { status: "budget_exceeded"; required: number; compressed: boolean }
  | { status: "failed"; reason: string; compressed: boolean };

const topicContent = (topic: Memory["topics"][number]): string =>
  JSON.stringify({
    title: topic.title,
    description: topic.description,
    summary: topic.summary,
    sources: topic.sources,
    unresolved: topic.unresolved,
  });

/** Collapse proposal plus compression into one patch against the original snapshot. */
const effectivePatch = (
  before: Memory,
  finalCandidate: Memory,
  proposal: MemoryPatch,
): MemoryPatch => {
  const originals = new Map(before.topics.map((topic) => [topic.id, topic]));
  const replacements: MemoryPatch["replacements"] = [];
  const newTopics: MemoryPatch["newTopics"] = [];
  for (const topic of finalCandidate.topics) {
    const original = originals.get(topic.id);
    if (original === undefined) {
      newTopics.push({
        title: topic.title,
        description: topic.description,
        summary: topic.summary,
        sources: structuredClone(topic.sources),
        unresolved: [...topic.unresolved],
      });
    } else if (topicContent(original) !== topicContent(topic)) {
      replacements.push({
        topicId: original.id,
        expectedVersion: original.version,
        title: topic.title,
        description: topic.description,
        summary: topic.summary,
        sources: structuredClone(topic.sources),
        unresolved: [...topic.unresolved],
      });
    }
  }
  return {
    replacements,
    newTopics,
    addProtected: structuredClone(proposal.addProtected),
    supersedeProtected: structuredClone(proposal.supersedeProtected),
  };
};

const prepareWithinBudget = async (
  before: Memory,
  proposal: MemoryPatch,
  taskContext: TaskContext,
  dependencies: IngestDependencies,
): Promise<BudgetPreparation> => {
  const budget = dependencies.budget;
  if (budget === undefined)
    return {
      status: "ready",
      memory: applyPatch(before, proposal),
      patch: proposal,
      compressed: false,
    };
  if (
    !Number.isSafeInteger(budget.maxTokens) ||
    budget.maxTokens <= 0 ||
    !Number.isSafeInteger(budget.summaryBudgetTokens) ||
    budget.summaryBudgetTokens <= 0 ||
    typeof budget.tokenizer?.count !== "function"
  ) {
    return {
      status: "failed",
      reason: "invalid ingest budget context",
      compressed: false,
    };
  }
  const raw = {
    messages: budget.rawMessages,
    ...(budget.retainedFailures === undefined
      ? {}
      : { retainedFailures: budget.retainedFailures }),
    ...(budget.recentMessageCount === undefined
      ? {}
      : { recentMessageCount: budget.recentMessageCount }),
  };
  const candidate = applyPatch(before, proposal);
  const first = assembleContext(candidate, raw, taskContext, budget.tokenizer);
  if (
    first.totalTokens <= budget.maxTokens &&
    first.summaryTokens <= budget.summaryBudgetTokens
  ) {
    return {
      status: "ready",
      memory: candidate,
      patch: proposal,
      compressed: false,
    };
  }
  if (first.nonSummaryTokens >= budget.maxTokens) {
    return {
      status: "budget_exceeded",
      required: first.totalTokens,
      compressed: false,
    };
  }
  const target = Math.min(
    budget.summaryBudgetTokens,
    budget.maxTokens - first.nonSummaryTokens,
  );
  if (target <= 0)
    return {
      status: "budget_exceeded",
      required: first.totalTokens,
      compressed: false,
    };
  const deadline =
    budget.compressionDeadlineMs ??
    dependencies.writerDeadlineMs ??
    DEFAULT_WRITER_DEADLINE_MS;
  const compressed = await withDeadline(
    Promise.resolve()
      .then(() =>
        dependencies.writer.compress({
          memory: structuredClone(candidate),
          taskContext,
          maxSummaryTokens: target,
        }),
      )
      .then((value) => ({ type: "patch" as const, value }))
      .catch((cause: unknown) => ({ type: "failed" as const, cause })),
    deadline,
  );
  if (compressed.status === "timed_out")
    return {
      status: "failed",
      reason: `compression timed out after ${deadline}ms`,
      compressed: true,
    };
  if (compressed.value.type === "failed")
    return {
      status: "failed",
      reason: `compression failed: ${message(compressed.value.cause)}`,
      compressed: true,
    };
  const valid = validateCompressionPatch(candidate, compressed.value.value);
  if (!valid.ok)
    return {
      status: "failed",
      reason: `invalid compression patch: ${valid.error.message}`,
      compressed: true,
    };
  const compressedCandidate = applyPatch(candidate, valid.value);
  const second = assembleContext(
    compressedCandidate,
    raw,
    taskContext,
    budget.tokenizer,
  );
  if (
    second.totalTokens > budget.maxTokens ||
    second.summaryTokens > budget.summaryBudgetTokens
  )
    return {
      status: "budget_exceeded",
      required: second.totalTokens,
      compressed: true,
    };
  const patch = effectivePatch(before, compressedCandidate, proposal);
  return {
    status: "ready",
    memory: applyPatch(before, patch),
    patch,
    compressed: true,
  };
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
  const classifierCallFailure = await appendClassifierCalls(
    dependencies,
    attempt,
    chunk,
    memory,
  );
  if (classifierCallFailure !== undefined)
    return retained(
      chunk,
      `classifier call journal failed: ${classifierCallFailure}`,
    );
  const forcedWriter = protectedResult.value.length > 0;
  const routingJournaled = await dependencies.store.appendJournal({
    type: "routing_decision",
    id: journalId(chunk, attempt, "routing"),
    occurredAt: chunk.createdAt,
    chunkId: chunk.id,
    snapshotRevision: memory.revision,
    attemptId: attempt.id,
    effectiveMode: mode,
    classifierPolicy: dependencies.classifierPolicy,
    route:
      classification.failure !== undefined
        ? "unavailable"
        : (classification.routing?.kind ?? "writer"),
    reason:
      classification.failure?.message ??
      classification.routing?.reason ??
      "writer",
    affectedTopicIds: classification.routing?.affectedTopicIds ?? [],
    protectionOverride:
      forcedWriter && classification.routing?.kind === "bypass",
    ...(classification.relevance === undefined
      ? {}
      : { relevance: classification.relevance }),
    ...(classification.assessment === undefined
      ? {}
      : { assessment: classification.assessment }),
  });
  if (!routingJournaled.ok)
    return retained(
      chunk,
      `routing journal failed: ${routingJournaled.error.message}`,
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
      attemptId: attempt.id,
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

  const action = forcedWriter
    ? "writer"
    : modeAction(mode, classification.routing);
  if (action === "bypass") {
    const emptyPatch: MemoryPatch = {
      replacements: [],
      newTopics: [],
      addProtected: [],
      supersedeProtected: [],
    };
    const prepared = await prepareWithinBudget(
      memory,
      emptyPatch,
      taskContext,
      dependencies,
    );
    if (prepared.compressed) {
      const callFailure = await appendAdapterCall(
        dependencies,
        attempt,
        chunk,
        memory,
        "writer",
        "compress",
        lastAdapterCall(dependencies.writer),
        prepared.status === "failed" ? "failed" : "succeeded",
      );
      if (callFailure !== undefined)
        return retained(
          chunk,
          `compression call journal failed: ${callFailure}`,
        );
    }
    if (prepared.status === "failed")
      return retainAtGate(
        dependencies,
        attempt,
        chunk,
        memory,
        "budget",
        "failure",
        prepared.reason,
      );
    if (prepared.status === "budget_exceeded") {
      const journaled = await dependencies.store.appendJournal({
        type: "gate_decision",
        id: journalId(chunk, attempt, "gate-budget"),
        occurredAt: chunk.createdAt,
        chunkId: chunk.id,
        snapshotRevision: memory.revision,
        attemptId: attempt.id,
        gate: "budget",
        outcome: "failure",
        reason: `candidate requires ${prepared.required} tokens; budget is ${dependencies.budget?.maxTokens}`,
        effectiveMode: effectiveMode(dependencies),
        classifierPolicy: dependencies.classifierPolicy,
        executionPolicy: executionPolicy(dependencies),
      });
      if (!journaled.ok)
        return retained(
          chunk,
          `budget journal failed: ${journaled.error.message}`,
        );
      return {
        status: "budget_exceeded",
        chunkId: chunk.id,
        budget: dependencies.budget?.maxTokens ?? 1,
        required: prepared.required,
      };
    }
    if (hasChanges(prepared.patch)) {
      const after = applyPatch(memory, prepared.patch, chunk.id);
      const call = lastAdapterCall(dependencies.writer);
      const commit = buildCommit(memory, after, chunk, prepared.patch, {
        ...(classification.relevance === undefined
          ? {}
          : { relevance: classification.relevance }),
        ...(classification.assessment === undefined
          ? {}
          : { assessment: classification.assessment }),
        reason: "budget compression during classifier bypass",
        attemptId: attempt.id,
        ...(call === undefined
          ? {}
          : {
              writerModel: modelIdentifier(call),
              writerUsage: call.usage,
              writerLatencyMs: call.latencyMs,
            }),
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
            status: "committed",
            chunkId: chunk.id,
            revision: result.value.revision,
          };
    }
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
      attemptId: attempt.id,
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
    await appendAdapterCall(
      dependencies,
      attempt,
      chunk,
      memory,
      "writer",
      "propose",
      lastAdapterCall(dependencies.writer),
      "timed_out",
    );
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
    const callJournalFailure = await appendAdapterCall(
      dependencies,
      attempt,
      chunk,
      memory,
      "writer",
      "propose",
      lastAdapterCall(dependencies.writer),
      "failed",
    );
    if (callJournalFailure !== undefined)
      return retained(
        chunk,
        `writer call journal failed: ${callJournalFailure}`,
      );
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
  const proposalCall = adapterCallFor(dependencies.writer, proposed);
  const proposalCallFailure = await appendAdapterCall(
    dependencies,
    attempt,
    chunk,
    memory,
    "writer",
    "propose",
    proposalCall,
  );
  if (proposalCallFailure !== undefined)
    return retained(
      chunk,
      `writer call journal failed: ${proposalCallFailure}`,
    );
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
  const prepared = await prepareWithinBudget(
    memory,
    valid.value,
    taskContext,
    dependencies,
  );
  if (prepared.compressed) {
    const compressionCallFailure = await appendAdapterCall(
      dependencies,
      attempt,
      chunk,
      memory,
      "writer",
      "compress",
      lastAdapterCall(dependencies.writer),
      prepared.status === "failed" ? "failed" : "succeeded",
    );
    if (compressionCallFailure !== undefined)
      return retained(
        chunk,
        `compression call journal failed: ${compressionCallFailure}`,
      );
  }
  if (prepared.status === "failed") {
    return retainAtGate(
      dependencies,
      attempt,
      chunk,
      memory,
      "budget",
      "failure",
      prepared.reason,
    );
  }
  if (prepared.status === "budget_exceeded") {
    const journaled = await dependencies.store.appendJournal({
      type: "gate_decision",
      id: journalId(chunk, attempt, "gate-budget"),
      occurredAt: chunk.createdAt,
      chunkId: chunk.id,
      snapshotRevision: memory.revision,
      attemptId: attempt.id,
      gate: "budget",
      outcome: "failure",
      reason: `candidate requires ${prepared.required} tokens; budget is ${dependencies.budget?.maxTokens}`,
      effectiveMode: effectiveMode(dependencies),
      classifierPolicy: dependencies.classifierPolicy,
      executionPolicy: executionPolicy(dependencies),
    });
    if (!journaled.ok)
      return retained(
        chunk,
        `budget journal failed: ${journaled.error.message}`,
      );
    return {
      status: "budget_exceeded",
      chunkId: chunk.id,
      budget: dependencies.budget?.maxTokens ?? 1,
      required: prepared.required,
    };
  }
  const changed = hasChanges(prepared.patch);
  const after = changed
    ? applyPatch(memory, prepared.patch, chunk.id)
    : undefined;
  const writerCall = proposalCall ?? lastAdapterCall(dependencies.writer);
  const commit = buildCommit(
    memory,
    after,
    chunk,
    changed ? prepared.patch : undefined,
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
      attemptId: attempt.id,
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
  constructor(readonly dependencies: PipelineDependencies) {}

  ingest(chunk: Chunk, taskContext: TaskContext): Promise<IngestResult> {
    return ingest(chunk, taskContext, this.dependencies);
  }
}
