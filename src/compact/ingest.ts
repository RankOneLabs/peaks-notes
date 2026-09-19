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
  RelevanceResult,
  Result,
  TaskContext,
  Writer,
} from "../schema";
import { JournalEntryIdSchema } from "../schema";
import { applyPatch } from "./apply_patch";
import { runBaseline } from "./baseline";
import { buildCommit } from "./build_commit";
import { decideRouting, type RoutingDecision } from "./decide_routing";
import { DEFAULT_AUDIT_DEADLINE_MS, modeAction, withDeadline } from "./modes";
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

export type IngestDependencies = {
  store: IngestStore;
  classifier: Classifier;
  writer: Writer;
  evaluator?: Evaluator;
  classifierPolicy: ClassifierPolicy;
  executionPolicy?: ExecutionPolicy;
  mode?: "shadow" | "active" | "baseline";
  auditDeadlineMs?: number;
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

const journalId = (chunk: Chunk, suffix: string): JournalEntryId =>
  JournalEntryIdSchema.parse(`journal-${chunk.id}-${suffix}`);

const executionPolicy = (dependencies: IngestDependencies): ExecutionPolicy =>
  dependencies.executionPolicy ?? {
    mode: dependencies.mode === "active" ? "active" : "shadow",
    bypassAuditRate: 0,
    auditSeed: "",
  };

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
    const relevance = await classifier.scoreRelevance({
      chunk,
      taskContext,
      topics: memory.topics.map(({ id, title, description }) => ({
        id,
        title,
        description,
      })),
    });
    const selected = selectTopics(memory.topics, relevance, policy);
    if (!selected.ok) {
      return {
        relevance,
        failure: { gate: selected.error.gate, message: selected.error.message },
      };
    }
    const assessment = await classifier.classifyRelationships({
      chunk,
      taskContext,
      selectedTopics: selected.value,
      topicCatalog: memory.topics.map(({ id, title, description }) => ({
        id,
        title,
        description,
      })),
      protectedRecords: memory.protected,
    });
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
  chunk: Chunk,
  memory: Memory,
  gate: GateDecisionJournalEntry["gate"],
  outcome: GateDecisionJournalEntry["outcome"],
  reason: string,
): Promise<IngestResult> => {
  await dependencies.store.appendJournal({
    type: "gate_decision",
    id: journalId(chunk, `gate-${gate}`),
    occurredAt: chunk.createdAt,
    chunkId: chunk.id,
    snapshotRevision: memory.revision,
    gate,
    outcome,
    reason,
    classifierPolicy: dependencies.classifierPolicy,
    executionPolicy: executionPolicy(dependencies),
  });
  return retained(chunk, reason);
};

const appendAudit = async (
  dependencies: IngestDependencies,
  chunk: Chunk,
  memory: Memory,
  taskContext: TaskContext,
  sampled: boolean,
): Promise<void> => {
  const policy = executionPolicy(dependencies);
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
      dependencies.writer
        .propose({
          chunk,
          memory: structuredClone(memory),
          taskContext,
          affectedTopicIds: memory.topics.map(({ id }) => id),
        })
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
  await dependencies.store.appendJournal({
    type: "audit_record",
    id: journalId(chunk, "audit"),
    occurredAt: chunk.createdAt,
    chunkId: chunk.id,
    snapshotRevision: memory.revision,
    policy,
    sampled,
    proposedBypass: true,
    outcome,
    ...(patch === undefined ? {} : { patch }),
  });

  if (
    patch !== undefined &&
    hasChanges(patch) &&
    dependencies.evaluator !== undefined
  ) {
    try {
      const after = applyPatch(memory, patch);
      const comparison = await dependencies.evaluator.compare({
        before: memory,
        after,
        chunk,
        taskContext,
      });
      await dependencies.store.appendJournal({
        type: "semantic_comparison",
        id: journalId(chunk, "comparison"),
        occurredAt: chunk.createdAt,
        chunkId: chunk.id,
        snapshotRevision: memory.revision,
        comparison,
        evaluatorModel: {
          provider: "stub",
          model: "deterministic-evaluator",
          promptVersion: "fixture-v1",
        },
        evaluatorUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        evaluatorLatencyMs: 0,
      });
    } catch {
      // Comparisons are evaluation-only and never change the live decision.
    }
  }
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
  const protectedResult = protect(chunk);
  if (!protectedResult.ok) {
    return retainAtGate(
      dependencies,
      chunk,
      memory,
      "protect",
      "failure",
      protectedResult.error.message,
    );
  }
  const mode =
    dependencies.mode ?? dependencies.executionPolicy?.mode ?? "shadow";
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
      chunk,
      memory,
      classification.failure.gate,
      "escalation",
      `classifier escalation: ${classification.failure.message}`,
    );
  }
  if (mode === "shadow" && classification.routing?.kind === "bypass") {
    const policy = dependencies.executionPolicy ?? {
      mode: "shadow" as const,
      bypassAuditRate: 0,
      auditSeed: "",
    };
    await dependencies.store.appendJournal({
      type: "audit_record",
      id: journalId(chunk, "shadow-routing"),
      occurredAt: chunk.createdAt,
      chunkId: chunk.id,
      snapshotRevision: memory.revision,
      policy: { ...policy, mode: "shadow" },
      sampled: false,
      proposedBypass: true,
      outcome: "not_sampled",
    });
  }

  const forcedWriter = protectedResult.value.length > 0;
  const action = forcedWriter
    ? "writer"
    : modeAction(mode, classification.routing);
  if (action === "bypass") {
    const policy = dependencies.executionPolicy ?? {
      mode: "active" as const,
      bypassAuditRate: 0,
      auditSeed: "",
    };
    const sampled = sampleAudit(
      chunk.id,
      policy.auditSeed,
      policy.bypassAuditRate,
    );
    await appendAudit(dependencies, chunk, memory, taskContext, sampled);
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

  let proposed: MemoryPatch;
  try {
    proposed =
      mode === "baseline"
        ? await runBaseline(
            dependencies.writer,
            chunk,
            structuredClone(memory),
            taskContext,
          )
        : await dependencies.writer.propose({
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
          });
  } catch (cause) {
    return retainAtGate(
      dependencies,
      chunk,
      memory,
      "writer",
      "failure",
      `writer failed: ${message(cause)}`,
    );
  }
  const merged: MemoryPatch = {
    ...proposed,
    addProtected: [
      ...proposed.addProtected,
      ...protectedResult.value.filter(
        (record) => !proposed.addProtected.some(({ id }) => id === record.id),
      ),
    ],
  };
  const valid = validatePatch(memory, chunk, merged);
  if (!valid.ok) {
    return retainAtGate(
      dependencies,
      chunk,
      memory,
      valid.error.gate,
      "escalation",
      `patch escalation: ${valid.error.message}`,
    );
  }
  const changed = hasChanges(valid.value);
  const after = changed ? applyPatch(memory, valid.value, chunk.id) : undefined;
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
