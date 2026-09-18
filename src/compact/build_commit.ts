import type {
  Assessment,
  Chunk,
  Commit,
  Memory,
  MemoryPatch,
  ModelIdentifier,
  RelevanceResult,
} from "../schema";

const usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
const writerModel: ModelIdentifier = {
  provider: "stub",
  model: "deterministic-writer",
  promptVersion: "fixture-v1",
};

export type CommitBuildOptions = {
  occurredAt?: string;
  relevance?: RelevanceResult;
  assessment?: Assessment;
  reason?: string;
};

export const buildCommit = (
  before: Memory,
  after: Memory | undefined,
  chunk: Chunk,
  patch: MemoryPatch | undefined,
  options: CommitBuildOptions = {},
): Commit => {
  const occurredAt = options.occurredAt ?? chunk.createdAt;
  const classifier = {
    ...(options.relevance === undefined ? {} : { relevance: options.relevance }),
    ...(options.assessment === undefined ? {} : { assessment: options.assessment }),
  };
  if (after === undefined || patch === undefined) {
    return {
      type: "no_update",
      chunkId: chunk.id,
      journalEntry: {
        type: "no_update",
        id: `journal-${chunk.id}-no-update` as Commit["journalEntry"]["id"],
        occurredAt,
        chunkId: chunk.id,
        snapshotRevision: before.revision,
        previousRevision: before.revision,
        newRevision: before.revision,
        classifier,
        reason: options.reason ?? "no update required",
      },
    };
  }
  return {
    type: "committed_update",
    chunkId: chunk.id,
    memory: after,
    journalEntry: {
      type: "committed_update",
      id: `journal-${chunk.id}-commit` as Commit["journalEntry"]["id"],
      occurredAt,
      chunkId: chunk.id,
      snapshotRevision: before.revision,
      previousRevision: before.revision,
      newRevision: after.revision,
      ...(Object.keys(classifier).length === 0 ? {} : { classifier }),
      writerModel,
      proposedPatch: patch,
      writerUsage: usage,
      writerLatencyMs: 0,
      previousTopics: structuredClone(before.topics),
    },
  };
};
