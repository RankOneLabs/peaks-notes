import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import type { Commit, Memory, Topic } from "../schema";
import { SqliteStore } from "./sqlite";

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

const pathForTest = (): string => {
  const path = `/tmp/peaks-store-${randomUUID()}.db`;
  databasePaths.push(path);
  return path;
};

const topic = (version: number, summary: string): Topic => ({
  id: "topic-1" as Topic["id"],
  title: "Camera network",
  description: "Camera connectivity and configuration",
  version,
  summary,
  sources: [
    {
      messageId: `message-${version}` as Topic["sources"][number]["messageId"],
    },
  ],
  unresolved: [],
});

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const writerModel = { provider: "test", model: "writer", promptVersion: "1" };

const commit = (
  chunkId: string,
  expectedRevision: number,
  memory: Memory,
  previousTopics: Topic[],
): Commit => ({
  type: "committed_update",
  chunkId: chunkId as Commit["chunkId"],
  memory,
  journalEntry: {
    type: "committed_update",
    id: `journal-${chunkId}` as Commit["journalEntry"]["id"],
    occurredAt: "2026-09-18T00:00:00.000Z",
    chunkId: chunkId as Commit["chunkId"],
    snapshotRevision: expectedRevision,
    previousRevision: expectedRevision,
    newRevision: expectedRevision + 1,
    writerModel,
    proposedPatch: {
      replacements: [],
      newTopics: [],
      addProtected: [],
      supersedeProtected: [],
    },
    writerUsage: usage,
    writerLatencyMs: 1,
    previousTopics,
  },
});

const noUpdateCommit = (chunkId: string, revision: number): Commit => ({
  type: "no_update",
  chunkId: chunkId as Commit["chunkId"],
  journalEntry: {
    type: "no_update",
    id: `journal-${chunkId}` as Commit["journalEntry"]["id"],
    occurredAt: "2026-09-18T00:00:00.000Z",
    chunkId: chunkId as Commit["chunkId"],
    snapshotRevision: revision,
    previousRevision: revision,
    newRevision: revision,
    classifier: {},
    reason: "all information is already represented",
  },
});

const memoryAt = (
  revision: number,
  chunks: string[],
  topics: Topic[] = [],
): Memory => ({
  revision,
  topics,
  protected: [],
  processedChunkIds: chunks as Memory["processedChunkIds"],
});

const counts = (path: string): { journal: number; processed: number } => {
  const database = new Database(path, { readonly: true, strict: true });
  const journal = database
    .query<{ count: number }, []>("SELECT count(*) AS count FROM journal")
    .get();
  const processed = database
    .query<{ count: number }, []>(
      "SELECT count(*) AS count FROM processed_chunks",
    )
    .get();
  database.close();
  if (journal === null || processed === null)
    throw new Error("count query failed");
  return { journal: journal.count, processed: processed.count };
};

const memoryDocument = (path: string): string => {
  const database = new Database(path, { readonly: true, strict: true });
  const row = database
    .query<{ document: string }, []>(
      "SELECT document FROM memory_state WHERE singleton = 1",
    )
    .get();
  database.close();
  if (row === null) throw new Error("memory query failed");
  return row.document;
};

describe("SqliteStore", () => {
  test("a stale revision changes no state", async () => {
    const path = pathForTest();
    const store = new SqliteStore(path);
    const result = await store.commit(
      4,
      commit("chunk-stale", 4, memoryAt(5, ["chunk-stale"]), []),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("stale_revision");
    const loaded = await store.load();
    expect(loaded).toEqual({ ok: true, value: memoryAt(0, []) });
    expect(counts(path)).toEqual({ journal: 0, processed: 0 });
    store.close();
  });

  test("failure after memory write rolls back the whole commit", async () => {
    const path = pathForTest();
    const store = new SqliteStore(path);
    const faultConnection = new Database(path, { strict: true });
    faultConnection.exec(`
      CREATE TRIGGER fail_journal_insert
      BEFORE INSERT ON journal
      BEGIN
        SELECT RAISE(ABORT, 'injected journal failure');
      END;
    `);
    faultConnection.close();
    const result = await store.commit(
      0,
      commit("chunk-fail", 0, memoryAt(1, ["chunk-fail"]), []),
    );

    expect(result.ok).toBe(false);
    expect(await store.load()).toEqual({ ok: true, value: memoryAt(0, []) });
    expect(counts(path)).toEqual({ journal: 0, processed: 0 });
    store.close();
  });

  test("replaying a committed chunk is a no-op", async () => {
    const path = pathForTest();
    const store = new SqliteStore(path);
    const change = commit("chunk-1", 0, memoryAt(1, ["chunk-1"]), []);
    expect(await store.commit(0, change)).toEqual({
      ok: true,
      value: { status: "committed", revision: 1 },
    });
    expect(await store.commit(0, change)).toEqual({
      ok: true,
      value: { status: "replayed", revision: 1 },
    });
    expect(counts(path)).toEqual({ journal: 1, processed: 1 });
    store.close();
  });

  test("a no-update commit cannot replace live memory", async () => {
    const path = pathForTest();
    const store = new SqliteStore(path);
    const version1 = topic(1, "Cameras use local RTSP.");
    await store.commit(
      0,
      commit("chunk-1", 0, memoryAt(1, ["chunk-1"], [version1]), []),
    );
    const before = memoryDocument(path);

    expect(await store.commit(1, noUpdateCommit("chunk-2", 1))).toEqual({
      ok: true,
      value: { status: "committed", revision: 1 },
    });
    expect(memoryDocument(path)).toBe(before);
    expect(await store.load()).toEqual({
      ok: true,
      value: memoryAt(1, ["chunk-1", "chunk-2"], [version1]),
    });
    expect(counts(path)).toEqual({ journal: 2, processed: 2 });
    store.close();
  });

  test("rejects a journal snapshot from another revision", async () => {
    const path = pathForTest();
    const store = new SqliteStore(path);
    const change = commit(
      "chunk-snapshot",
      0,
      memoryAt(1, ["chunk-snapshot"]),
      [],
    );
    change.journalEntry.snapshotRevision = 1;

    const result = await store.commit(0, change);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation_error");
    expect(counts(path)).toEqual({ journal: 0, processed: 0 });
    store.close();
  });

  test("returns a validation error for malformed stored memory JSON", async () => {
    const path = pathForTest();
    const store = new SqliteStore(path);
    const faultConnection = new Database(path, { strict: true });
    faultConnection
      .query("UPDATE memory_state SET document = ? WHERE singleton = 1")
      .run("{");
    faultConnection.close();

    const result = await store.load();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation_error");
    store.close();
  });

  test("returns a validation error for an invalid committed journal document", async () => {
    const path = pathForTest();
    const store = new SqliteStore(path);
    await store.commit(
      0,
      commit("chunk-1", 0, memoryAt(1, ["chunk-1"], [topic(1, "v1")]), []),
    );
    const faultConnection = new Database(path, { strict: true });
    faultConnection
      .query(
        "UPDATE journal SET document = ? WHERE entry_type = 'committed_update'",
      )
      .run("{}");
    faultConnection.close();

    const result = await store.recoverTopicVersions(topic(1, "v1").id);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("validation_error");
    store.close();
  });

  test("evaluation journal entries do not change memory or processed markers", async () => {
    const path = pathForTest();
    const store = new SqliteStore(path);
    const result = await store.appendJournal({
      type: "audit_record",
      id: "audit-1" as never,
      occurredAt: "2026-09-18T00:00:00.000Z",
      chunkId: "chunk-audit" as never,
      snapshotRevision: 0,
      policy: { mode: "active", bypassAuditRate: 1, auditSeed: "seed" },
      sampled: true,
      proposedBypass: true,
      outcome: "empty_patch",
    });

    expect(result.ok).toBe(true);
    expect(await store.load()).toEqual({ ok: true, value: memoryAt(0, []) });
    expect(counts(path)).toEqual({ journal: 1, processed: 0 });
    store.close();
  });

  test("recovers prior topic versions after successive commits", async () => {
    const path = pathForTest();
    const store = new SqliteStore(path);
    const version1 = topic(1, "Cameras use local RTSP.");
    const version2 = topic(
      2,
      "Cameras use local RTSP and internet is blocked.",
    );

    await store.commit(
      0,
      commit("chunk-1", 0, memoryAt(1, ["chunk-1"], [version1]), []),
    );
    await store.commit(
      1,
      commit("chunk-2", 1, memoryAt(2, ["chunk-1", "chunk-2"], [version2]), [
        version1,
      ]),
    );
    const recovered = await store.recoverTopicVersions(version1.id);

    expect(recovered).toEqual({ ok: true, value: [version1, version2] });
    store.close();
  });
});
