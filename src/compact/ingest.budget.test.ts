import { expect, test } from "bun:test";
import { StubClassifier } from "../classifier/stub";
import type { MemoryPatch, Tokenizer } from "../schema";
import { SqliteStore } from "../store/sqlite";
import { StubWriter } from "../writer/stub";
import { ingest } from "./ingest";

const chunk = {
  id: "chunk-budget-gate" as never,
  createdAt: "2026-09-19T00:00:00.000Z",
  messages: [
    { id: "message-budget" as never, role: "user" as const, content: "fact" },
  ],
};
const taskContext = { currentTask: "test", compactionInstructions: [] };
const classifierPolicy = {
  relevanceThreshold: 0.5,
  sameInfoMinConfidence: 0.8,
  uncoveredNoChangeMinConfidence: 0.8,
};
const executionPolicy = {
  mode: "shadow" as const,
  bypassAuditRate: 0,
  auditSeed: "budget",
};
const tokenizer: Tokenizer = {
  count: (text) => ({
    tokens: text.includes("LONG") ? 100 : 1,
    method: "target_tokenizer",
  }),
};
const topic = (summary: string): MemoryPatch => ({
  replacements: [],
  newTopics: [
    {
      title: "Budget",
      description: "budget",
      summary,
      sources: [{ messageId: "message-budget" as never }],
      unresolved: [],
    },
  ],
  addProtected: [],
  supersedeProtected: [],
});
const compression = (summary: string): MemoryPatch => ({
  replacements: [
    {
      topicId: "topic-1-1" as never,
      expectedVersion: 1,
      title: "Budget",
      description: "budget",
      summary,
      sources: [{ messageId: "message-budget" as never }],
      unresolved: [],
    },
  ],
  newTopics: [],
  addProtected: [],
  supersedeProtected: [],
});

const dependencies = (
  store: SqliteStore,
  writer: StubWriter,
  attemptId = "budget-attempt",
) => ({
  store,
  classifier: new StubClassifier(),
  writer,
  classifierPolicy,
  executionPolicy,
  budget: {
    maxTokens: 1_000,
    summaryBudgetTokens: 10,
    tokenizer,
  },
  attemptIdFactory: () => attemptId,
});

test("an unsuccessful pre-commit compression leaves SQLite memory retryable", async () => {
  const store = new SqliteStore();
  const failed = await ingest(
    chunk,
    taskContext,
    dependencies(
      store,
      new StubWriter({
        proposals: [{ output: topic("LONG proposal") }],
        compressions: [{ output: compression("LONG compression") }],
      }),
    ),
  );
  expect(failed).toMatchObject({ status: "budget_exceeded", budget: 1_000 });
  expect(await store.load()).toMatchObject({
    ok: true,
    value: { revision: 0, topics: [], processedChunkIds: [] },
  });

  const retry = await ingest(
    chunk,
    taskContext,
    dependencies(
      store,
      new StubWriter({ proposals: [{ output: topic("short") }] }),
      "budget-retry",
    ),
  );
  expect(retry).toMatchObject({ status: "committed", revision: 1 });
  store.close();
});

test("successful compression becomes one commit with version-one new topics", async () => {
  const store = new SqliteStore();
  const result = await ingest(
    chunk,
    taskContext,
    dependencies(
      store,
      new StubWriter({
        proposals: [{ output: topic("LONG proposal") }],
        compressions: [{ output: compression("short") }],
      }),
    ),
  );
  expect(result).toMatchObject({ status: "committed", revision: 1 });
  expect(await store.load()).toMatchObject({
    ok: true,
    value: {
      revision: 1,
      topics: [{ id: "topic-1-1", version: 1, summary: "short" }],
      processedChunkIds: ["chunk-budget-gate"],
    },
  });
  store.close();
});
