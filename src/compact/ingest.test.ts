import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import type {
  Commit,
  DomainError,
  EvaluationJournalEntry,
  Memory,
  Result,
  Topic,
  TopicId,
} from "../schema";
import { ok } from "../schema";
import { StubClassifier } from "../classifier/stub";
import { StubEvaluator } from "../evaluator/stub";
import { DeterministicFixtureSchema } from "../replay/fixture";
import { renderContext } from "../render/render";
import type { CommitResult, Store } from "../store/store";
import { StubWriter } from "../writer/stub";
import { ingest } from "./ingest";

class MemoryStore implements Store {
  memory: Memory;
  readonly journal: EvaluationJournalEntry[] = [];

  constructor(memory: Memory) {
    this.memory = structuredClone(memory);
  }

  async archive(): Promise<Result<void, DomainError>> {
    return ok(undefined);
  }

  async load(): Promise<Result<Memory, DomainError>> {
    return ok(structuredClone(this.memory));
  }

  async commit(_expectedRevision: number, change: Commit): Promise<Result<CommitResult, DomainError>> {
    if (this.memory.processedChunkIds.includes(change.chunkId)) {
      return ok({ status: "replayed", revision: this.memory.revision });
    }
    if (change.type === "committed_update") this.memory = structuredClone(change.memory);
    else this.memory.processedChunkIds.push(change.chunkId);
    return ok({ status: "committed", revision: this.memory.revision });
  }

  async appendJournal(entry: EvaluationJournalEntry): Promise<Result<void, DomainError>> {
    this.journal.push(structuredClone(entry));
    return ok(undefined);
  }

  async recoverTopicVersions(_topicId: TopicId): Promise<Result<Topic[], DomainError>> {
    return ok([]);
  }
}

const fixtures = readdirSync("fixtures/deterministic")
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) =>
    DeterministicFixtureSchema.parse(
      JSON.parse(readFileSync(`fixtures/deterministic/${name}`, "utf8")),
    ),
  );

describe("deterministic fixtures", () => {
  test("the complete named fixture set is present", () => {
    expect(fixtures.map(({ name }) => name).sort()).toEqual([
      "audit timeout",
      "classifier failure in shadow",
      "existing plus new topic in one transaction",
      "explicit preservation instruction",
      "failed budget reduction",
      "low-confidence same-info",
      "malformed response",
      "no-match with useful content",
      "overlong input",
      "replayed chunk",
      "same-seed audit assignment",
      "state-changing receipt",
      "timeout",
      "transient chatter",
      "two-topic chunk",
    ].sort());
  });

  for (const fixture of fixtures) {
    test(fixture.name, async () => {
      const writer = new StubWriter({ proposals: fixture.stubs.proposals, compressions: fixture.stubs.compressions });
      if (fixture.expected.status === "budget_exceeded") {
        const result = await renderContext(
          fixture.initialMemory,
          fixture.chunk.messages,
          { maxTokens: 1, warningThreshold: 0.8 },
          { writer, taskContext: fixture.taskContext },
        );
        expect(result.status).toBe("budget_exceeded");
        return;
      }
      const store = new MemoryStore(fixture.initialMemory);
      const result = await ingest(fixture.chunk, fixture.taskContext, {
        store,
        classifier: new StubClassifier({ relevance: fixture.stubs.relevance, assessments: fixture.stubs.assessments }),
        writer,
        evaluator: new StubEvaluator(fixture.stubs.comparisons),
        classifierPolicy: fixture.classifierPolicy,
        executionPolicy: fixture.executionPolicy,
        ...(fixture.auditDeadlineMs === undefined ? {} : { auditDeadlineMs: fixture.auditDeadlineMs }),
      });
      expect(result.status).toBe(fixture.expected.status as typeof result.status);
      if ("revision" in result && fixture.expected.revision !== undefined) expect(result.revision).toBe(fixture.expected.revision);
      if (fixture.expected.reasonIncludes !== undefined) {
        expect("reason" in result ? result.reason : "").toContain(fixture.expected.reasonIncludes);
      }
      if (fixture.expected.auditSampled !== undefined) {
        const audit = store.journal.find((entry) => entry.type === "audit_record");
        expect(audit?.type === "audit_record" && audit.sampled).toBe(fixture.expected.auditSampled);
      }
    });
  }
});

test("shadow commits a writer patch despite a confident same-info decision", async () => {
  const fixture = fixtures.find(({ name }) => name === "same-seed audit assignment");
  if (fixture === undefined) throw new Error("fixture missing");
  const store = new MemoryStore(fixture.initialMemory);
  const writer = new StubWriter({ proposals: [{ output: { replacements: [{ topicId: "topic-1" as never, expectedVersion: 1, title: "Network", description: "Network facts", summary: "LAN only, confirmed.", sources: [{ messageId: "message-same" as never }], unresolved: [] }], newTopics: [], addProtected: [], supersedeProtected: [] } }] });
  const result = await ingest(fixture.chunk, fixture.taskContext, {
    store,
    classifier: new StubClassifier({ relevance: fixture.stubs.relevance, assessments: fixture.stubs.assessments }),
    writer,
    classifierPolicy: fixture.classifierPolicy,
    executionPolicy: { ...fixture.executionPolicy, mode: "shadow" },
  });
  expect(result.status).toBe("committed");
  expect(store.memory.topics[0]?.summary).toBe("LAN only, confirmed.");
  expect(writer.proposeCalls[0]?.assessment).toBeUndefined();
});

test("active full-rate audit journals but never applies its patch", async () => {
  const fixture = fixtures.find(({ name }) => name === "same-seed audit assignment");
  if (fixture === undefined) throw new Error("fixture missing");
  const store = new MemoryStore(fixture.initialMemory);
  const writer = new StubWriter({ proposals: [{ output: { replacements: [{ topicId: "topic-1" as never, expectedVersion: 1, title: "Network", description: "Network facts", summary: "audit-only change", sources: [{ messageId: "message-same" as never }], unresolved: [] }], newTopics: [], addProtected: [], supersedeProtected: [] } }] });
  const result = await ingest(fixture.chunk, fixture.taskContext, {
    store,
    classifier: new StubClassifier({ relevance: fixture.stubs.relevance, assessments: fixture.stubs.assessments }),
    writer,
    classifierPolicy: fixture.classifierPolicy,
    executionPolicy: fixture.executionPolicy,
  });
  expect(result).toMatchObject({ status: "no_update", revision: 1 });
  expect(store.memory.topics[0]?.summary).toBe("LAN only.");
  expect(store.journal[0]).toMatchObject({ type: "audit_record", outcome: "patch" });
});
