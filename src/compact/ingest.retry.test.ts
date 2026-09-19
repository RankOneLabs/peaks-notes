import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { StubEvaluator } from "../evaluator/stub";
import type { Chunk, Classifier, Commit, Memory, MemoryPatch } from "../schema";
import { err } from "../schema";
import { SqliteStore } from "../store/sqlite";
import { StubWriter } from "../writer/stub";
import { type IngestStore, ingest } from "./ingest";

const databasePaths: string[] = [];

afterEach(() => {
  for (const path of databasePaths.splice(0)) {
    for (const suffix of ["", "-shm", "-wal"]) {
      try {
        rmSync(`${path}${suffix}`);
      } catch {}
    }
  }
});

const initialMemory: Memory = {
  revision: 1,
  topics: [
    {
      id: "topic-1" as never,
      title: "Network",
      description: "Network facts",
      version: 1,
      summary: "LAN only.",
      sources: [{ messageId: "message-old" as never }],
      unresolved: [],
    },
  ],
  protected: [],
  processedChunkIds: ["chunk-seed" as never],
};

const chunk: Chunk = {
  id: "chunk-retry" as never,
  createdAt: "2026-09-18T00:00:00.000Z",
  messages: [
    { id: "message-retry" as never, role: "user", content: "LAN confirmed." },
  ],
};

const patch: MemoryPatch = {
  replacements: [
    {
      topicId: "topic-1" as never,
      expectedVersion: 1,
      title: "Network",
      description: "Network facts",
      summary: "LAN confirmed.",
      sources: [{ messageId: "message-retry" as never }],
      unresolved: [],
    },
  ],
  newTopics: [],
  addProtected: [],
  supersedeProtected: [],
};

const classifier: Classifier = {
  async scoreRelevance() {
    return { topics: [{ topicId: "topic-1" as never, score: 1 }] };
  },
  async classifyRelationships() {
    return {
      relations: [
        {
          topicId: "topic-1" as never,
          relationship: "same_info",
          confidence: 1,
        },
      ],
      uncovered: { outcome: "none", confidence: 1 },
    };
  },
};

const classifierPolicy = {
  relevanceThreshold: 0.5,
  sameInfoMinConfidence: 0.8,
  uncoveredNoChangeMinConfidence: 0.8,
};

const taskContext = {
  currentTask: "Configure network",
  compactionInstructions: [],
};

const openSeededStore = async (): Promise<{
  path: string;
  store: SqliteStore;
}> => {
  const path = `/tmp/peaks-ingest-retry-${randomUUID()}.db`;
  databasePaths.push(path);
  const store = new SqliteStore(path);
  const seed: Commit = {
    type: "committed_update",
    chunkId: "chunk-seed" as never,
    memory: initialMemory,
    journalEntry: {
      type: "committed_update",
      id: "journal-seed" as never,
      occurredAt: chunk.createdAt,
      chunkId: "chunk-seed" as never,
      snapshotRevision: 0,
      previousRevision: 0,
      newRevision: 1,
      writerModel: { provider: "test", model: "seed", promptVersion: "1" },
      proposedPatch: {
        replacements: [],
        newTopics: [],
        addProtected: [],
        supersedeProtected: [],
      },
      writerUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      writerLatencyMs: 0,
      previousTopics: [],
    },
  };
  const seeded = await store.commit(0, seed);
  if (!seeded.ok) throw new Error(seeded.error.message);
  return { path, store };
};

const journalIdsForChunk = (path: string): string[] => {
  const database = new Database(path, { readonly: true, strict: true });
  const rows = database
    .query<{ id: string }, []>(
      "SELECT entry_id AS id FROM journal WHERE chunk_id = 'chunk-retry' ORDER BY sequence",
    )
    .all();
  database.close();
  return rows.map(({ id }) => id);
};

test("a retained shadow attempt can retry with distinct SQLite journal identities", async () => {
  const { path, store } = await openSeededStore();
  const writer = new StubWriter({
    proposals: [{ error: "transient writer failure" }, { output: patch }],
  });
  let attempt = 0;
  const dependencies = {
    store,
    classifier,
    writer,
    classifierPolicy,
    executionPolicy: {
      mode: "shadow" as const,
      bypassAuditRate: 0,
      auditSeed: "retry-seed",
    },
    attemptIdFactory: () => `attempt-${++attempt}`,
  };

  const first = await ingest(chunk, taskContext, dependencies);
  const second = await ingest(chunk, taskContext, dependencies);
  const replay = await ingest(chunk, taskContext, dependencies);

  expect(first).toMatchObject({
    status: "retained",
    reason: expect.stringContaining("transient writer failure"),
  });
  expect(second).toMatchObject({ status: "committed", revision: 2 });
  expect(replay).toMatchObject({ status: "replayed", revision: 2 });
  expect(writer.proposeCalls).toHaveLength(2);
  expect(attempt).toBe(2);
  const ids = journalIdsForChunk(path);
  expect(ids).toHaveLength(4);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids.filter((id) => id.includes("attempt-1"))).toHaveLength(2);
  expect(ids.filter((id) => id.includes("attempt-2"))).toHaveLength(1);
  expect(ids).toContain("journal-chunk-retry-commit");
  store.close();
});

test("an active audited bypass retries after commit failure without journal collisions", async () => {
  const { path, store: sqlite } = await openSeededStore();
  let rejectCommit = true;
  const store: IngestStore = {
    archive: (value) => sqlite.archive(value),
    load: () => sqlite.load(),
    appendJournal: (entry) => sqlite.appendJournal(entry),
    commit: (revision, change) => {
      if (rejectCommit) {
        rejectCommit = false;
        return Promise.resolve(
          err({
            code: "storage_error" as const,
            operation: "commit",
            message: "injected commit failure",
          }),
        );
      }
      return sqlite.commit(revision, change);
    },
  };
  const writer = new StubWriter({
    proposals: [{ output: patch }, { output: patch }],
  });
  const evaluator = new StubEvaluator([
    { output: { verdict: "material_change", changes: [] } },
    { output: { verdict: "material_change", changes: [] } },
  ]);
  let attempt = 0;
  const dependencies = {
    store,
    classifier,
    writer,
    evaluator,
    classifierPolicy,
    executionPolicy: {
      mode: "active" as const,
      bypassAuditRate: 1,
      auditSeed: "retry-seed",
    },
    attemptIdFactory: () => `active-attempt-${++attempt}`,
  };

  const first = await ingest(chunk, taskContext, dependencies);
  const second = await ingest(chunk, taskContext, dependencies);

  expect(first).toMatchObject({
    status: "retained",
    reason: expect.stringContaining("injected commit failure"),
  });
  expect(second).toMatchObject({ status: "no_update", revision: 1 });
  expect(writer.proposeCalls).toHaveLength(2);
  expect(evaluator.calls).toHaveLength(2);
  const ids = journalIdsForChunk(path);
  expect(ids).toHaveLength(5);
  expect(new Set(ids).size).toBe(ids.length);
  sqlite.close();
});
