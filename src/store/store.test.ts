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

const memoryAt = (
  revision: number,
  chunks: string[],
  topics: Topic[] = [],
): Memory => ({
  revision,
  topics,
  protected: [],
  processedChunkIds: chunks,
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
    const store = new SqliteStore(path, {
      afterMemoryWrite: () => {
        throw new Error("injected journal failure");
      },
    });
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
