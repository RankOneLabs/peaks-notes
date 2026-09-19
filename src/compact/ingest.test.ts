import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { StubClassifier } from "../classifier/stub";
import { LlmEvaluator } from "../evaluator/llm_evaluator";
import { StubEvaluator } from "../evaluator/stub";
import { renderContext } from "../render/render";
import { DeterministicFixtureSchema } from "../replay/fixture";
import type {
  Classifier,
  Commit,
  DomainError,
  EvaluationJournalEntry,
  Evaluator,
  Memory,
  MemoryPatch,
  Result,
  Topic,
  TopicId,
  Writer,
} from "../schema";
import { err, ok } from "../schema";
import type { CommitResult, Store } from "../store/store";
import { RecordedProvider } from "../writer/recorded";
import { StubWriter } from "../writer/stub";
import { ingest } from "./ingest";
import { protect } from "./protect";

class MemoryStore implements Store {
  memory: Memory;
  readonly journal: EvaluationJournalEntry[] = [];
  readonly commits: Commit[] = [];

  constructor(memory: Memory) {
    this.memory = structuredClone(memory);
  }

  async archive(): Promise<Result<void, DomainError>> {
    return ok(undefined);
  }

  async load(): Promise<Result<Memory, DomainError>> {
    return ok(structuredClone(this.memory));
  }

  async commit(
    _expectedRevision: number,
    change: Commit,
  ): Promise<Result<CommitResult, DomainError>> {
    if (this.memory.processedChunkIds.includes(change.chunkId)) {
      return ok({ status: "replayed", revision: this.memory.revision });
    }
    this.commits.push(structuredClone(change));
    if (change.type === "committed_update")
      this.memory = structuredClone(change.memory);
    else this.memory.processedChunkIds.push(change.chunkId);
    return ok({ status: "committed", revision: this.memory.revision });
  }

  async appendJournal(
    entry: EvaluationJournalEntry,
  ): Promise<Result<void, DomainError>> {
    this.journal.push(structuredClone(entry));
    return ok(undefined);
  }

  async recoverTopicVersions(
    _topicId: TopicId,
  ): Promise<Result<Topic[], DomainError>> {
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
    expect(fixtures.map(({ name }) => name).sort()).toEqual(
      [
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
      ].sort(),
    );
  });

  for (const fixture of fixtures) {
    test(fixture.name, async () => {
      const writer = new StubWriter({
        proposals: fixture.stubs.proposals,
        compressions: fixture.stubs.compressions,
      });
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
        classifier: new StubClassifier({
          relevance: fixture.stubs.relevance,
          assessments: fixture.stubs.assessments,
        }),
        writer,
        evaluator: new StubEvaluator(fixture.stubs.comparisons),
        classifierPolicy: fixture.classifierPolicy,
        executionPolicy: fixture.executionPolicy,
        ...(fixture.auditDeadlineMs === undefined
          ? {}
          : { auditDeadlineMs: fixture.auditDeadlineMs }),
        ...(fixture.shadowComparisonDeadlineMs === undefined
          ? {}
          : {
              shadowComparisonDeadlineMs: fixture.shadowComparisonDeadlineMs,
            }),
        ...(fixture.writerDeadlineMs === undefined
          ? {}
          : { writerDeadlineMs: fixture.writerDeadlineMs }),
      });
      expect(result.status).toBe(
        fixture.expected.status as typeof result.status,
      );
      if ("revision" in result && fixture.expected.revision !== undefined)
        expect(result.revision).toBe(fixture.expected.revision);
      if (fixture.expected.reasonIncludes !== undefined) {
        expect("reason" in result ? result.reason : "").toContain(
          fixture.expected.reasonIncludes,
        );
      }
      if (fixture.expected.status === "retained") {
        expect(store.journal.at(-1)).toMatchObject({
          type: "gate_decision",
          classifierPolicy: fixture.classifierPolicy,
          executionPolicy: fixture.executionPolicy,
        });
      }
      if (fixture.expected.auditSampled !== undefined) {
        const audit = store.journal.find(
          (entry) => entry.type === "audit_record",
        );
        expect(audit?.type === "audit_record" && audit.sampled).toBe(
          fixture.expected.auditSampled,
        );
      }
      if (fixture.expected.auditOutcome !== undefined) {
        const audit = store.journal.find(
          (entry) => entry.type === "audit_record",
        );
        expect(audit?.type === "audit_record" ? audit.outcome : undefined).toBe(
          fixture.expected.auditOutcome,
        );
      }
    });
  }
});

test("baseline runs every deterministic fixture without classifier calls", async () => {
  let relevanceCalls = 0;
  let relationshipCalls = 0;
  const countingClassifier: Classifier = {
    async scoreRelevance() {
      relevanceCalls += 1;
      throw new Error("baseline must not score relevance");
    },
    async classifyRelationships() {
      relationshipCalls += 1;
      throw new Error("baseline must not classify relationships");
    },
  };

  for (const fixture of fixtures) {
    const store = new MemoryStore(fixture.initialMemory);
    await ingest(fixture.chunk, fixture.taskContext, {
      store,
      classifier: countingClassifier,
      writer: new StubWriter({
        proposals: fixture.stubs.proposals,
        compressions: fixture.stubs.compressions,
      }),
      classifierPolicy: fixture.classifierPolicy,
      executionPolicy: fixture.executionPolicy,
      mode: "baseline",
      writerDeadlineMs: fixture.writerDeadlineMs ?? 30_000,
    });
  }

  expect(relevanceCalls).toBe(0);
  expect(relationshipCalls).toBe(0);
});

test("unchanged live evaluation is journaled with the live model identity", async () => {
  const fixture = fixtures.find(
    ({ name }) => name === "same-seed audit assignment",
  );
  if (fixture === undefined) throw new Error("fixture missing");
  const topic = fixture.initialMemory.topics[0];
  if (topic === undefined) throw new Error("fixture topic missing");
  const store = new MemoryStore(fixture.initialMemory);
  const evaluatorProvider = new RecordedProvider([]);
  const evaluator = new LlmEvaluator(evaluatorProvider, {
    provider: "openai",
    apiKey: "unused",
    model: "live-evaluator-model",
    deadlineMs: 100,
    promptVersion: "evaluator-live-v7",
    maxInputTokens: 32_000,
  });
  const result = await ingest(fixture.chunk, fixture.taskContext, {
    store,
    classifier: new StubClassifier({
      relevance: fixture.stubs.relevance,
      assessments: fixture.stubs.assessments,
    }),
    writer: new StubWriter({
      proposals: [
        {
          output: {
            replacements: [
              {
                topicId: topic.id,
                expectedVersion: topic.version,
                title: topic.title,
                description: topic.description,
                summary: topic.summary,
                sources: topic.sources,
                unresolved: topic.unresolved,
              },
            ],
            newTopics: [],
            addProtected: [],
            supersedeProtected: [],
          },
        },
      ],
    }),
    evaluator,
    classifierPolicy: fixture.classifierPolicy,
    executionPolicy: { ...fixture.executionPolicy, mode: "shadow" },
    attemptIdFactory: () => "unchanged-live-evaluator",
  });

  expect(result.status).toBe("committed");
  expect(evaluatorProvider.requests).toHaveLength(0);
  expect(store.journal).toContainEqual(
    expect.objectContaining({
      type: "semantic_comparison",
      comparison: { verdict: "equivalent", changes: [] },
      evaluatorModel: {
        provider: "recorded",
        model: "live-evaluator-model",
        promptVersion: "evaluator-live-v7",
      },
    }),
  );
});

test("shadow commits a writer patch despite a confident same-info decision", async () => {
  const fixture = fixtures.find(
    ({ name }) => name === "same-seed audit assignment",
  );
  if (fixture === undefined) throw new Error("fixture missing");
  const store = new MemoryStore(fixture.initialMemory);
  const writer = new StubWriter({
    proposals: [
      {
        output: {
          replacements: [
            {
              topicId: "topic-1" as never,
              expectedVersion: 1,
              title: "Network",
              description: "Network facts",
              summary: "LAN only, confirmed.",
              sources: [{ messageId: "message-same" as never }],
              unresolved: [],
            },
          ],
          newTopics: [],
          addProtected: [],
          supersedeProtected: [],
        },
      },
    ],
  });
  const result = await ingest(fixture.chunk, fixture.taskContext, {
    store,
    classifier: new StubClassifier({
      relevance: fixture.stubs.relevance,
      assessments: fixture.stubs.assessments,
    }),
    writer,
    classifierPolicy: fixture.classifierPolicy,
    executionPolicy: { ...fixture.executionPolicy, mode: "shadow" },
  });
  expect(result.status).toBe("committed");
  expect(store.memory.topics[0]?.summary).toBe("LAN only, confirmed.");
  expect(writer.proposeCalls[0]?.assessment).toBeUndefined();
  expect(store.journal[0]).toMatchObject({
    type: "audit_record",
    proposedBypass: true,
    sampled: false,
  });
});

test("shadow compares a proposed bypass without letting evaluator mutation alter the commit", async () => {
  const fixture = fixtures.find(
    ({ name }) => name === "same-seed audit assignment",
  );
  if (fixture === undefined) throw new Error("fixture missing");
  const store = new MemoryStore(fixture.initialMemory);
  const writer = new StubWriter({
    proposals: [
      {
        output: {
          replacements: [
            {
              topicId: "topic-1" as never,
              expectedVersion: 1,
              title: "Network",
              description: "Network facts",
              summary: "LAN only, confirmed.",
              sources: [{ messageId: "message-same" as never }],
              unresolved: [],
            },
          ],
          newTopics: [],
          addProtected: [],
          supersedeProtected: [],
        },
      },
    ],
  });
  const calls: Parameters<Evaluator["compare"]>[0][] = [];
  const evaluator: Evaluator = {
    async compare(input) {
      calls.push(structuredClone(input));
      const topic = input.after.topics[0];
      if (topic === undefined) throw new Error("comparison topic missing");
      topic.summary = "evaluator mutation";
      return { verdict: "material_change", changes: [] };
    },
  };

  const result = await ingest(fixture.chunk, fixture.taskContext, {
    store,
    classifier: new StubClassifier({
      relevance: fixture.stubs.relevance,
      assessments: fixture.stubs.assessments,
    }),
    writer,
    evaluator,
    classifierPolicy: fixture.classifierPolicy,
    executionPolicy: { ...fixture.executionPolicy, mode: "shadow" },
    attemptIdFactory: () => "shadow-comparison",
  });

  expect(result.status).toBe("committed");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.before.topics[0]?.summary).toBe("LAN only.");
  expect(calls[0]?.after.topics[0]?.summary).toBe("LAN only, confirmed.");
  expect(store.memory.topics[0]?.summary).toBe("LAN only, confirmed.");
  expect(store.journal).toContainEqual(
    expect.objectContaining({
      type: "semantic_comparison",
      snapshotRevision: 1,
      comparison: { verdict: "material_change", changes: [] },
    }),
  );
  expect(Object.keys(calls[0] ?? {}).sort()).toEqual(
    ["after", "before", "chunk", "taskContext"].sort(),
  );
});

test("active full-rate audit journals but never applies its patch", async () => {
  const fixture = fixtures.find(
    ({ name }) => name === "same-seed audit assignment",
  );
  if (fixture === undefined) throw new Error("fixture missing");
  const store = new MemoryStore(fixture.initialMemory);
  const writer = new StubWriter({
    proposals: [
      {
        output: {
          replacements: [
            {
              topicId: "topic-1" as never,
              expectedVersion: 1,
              title: "Network",
              description: "Network facts",
              summary: "audit-only change",
              sources: [{ messageId: "message-same" as never }],
              unresolved: [],
            },
          ],
          newTopics: [],
          addProtected: [],
          supersedeProtected: [],
        },
      },
    ],
  });
  const result = await ingest(fixture.chunk, fixture.taskContext, {
    store,
    classifier: new StubClassifier({
      relevance: fixture.stubs.relevance,
      assessments: fixture.stubs.assessments,
    }),
    writer,
    classifierPolicy: fixture.classifierPolicy,
    executionPolicy: fixture.executionPolicy,
  });
  expect(result).toMatchObject({ status: "no_update", revision: 1 });
  expect(store.memory.topics[0]?.summary).toBe("LAN only.");
  expect(store.journal[0]).toMatchObject({
    type: "audit_record",
    outcome: "patch",
  });
});

test("a non-settling active evaluator is bounded by the remaining audit budget", async () => {
  const fixture = fixtures.find(
    ({ name }) => name === "same-seed audit assignment",
  );
  if (fixture === undefined) throw new Error("fixture missing");
  const store = new MemoryStore(fixture.initialMemory);
  const writer = new StubWriter({
    proposals: [
      {
        output: {
          replacements: [
            {
              topicId: "topic-1" as never,
              expectedVersion: 1,
              title: "Network",
              description: "Network facts",
              summary: "audit-only change",
              sources: [{ messageId: "message-same" as never }],
              unresolved: [],
            },
          ],
          newTopics: [],
          addProtected: [],
          supersedeProtected: [],
        },
      },
    ],
  });
  let evaluatorCalls = 0;
  const evaluator: Evaluator = {
    compare() {
      evaluatorCalls += 1;
      return new Promise(() => {});
    },
  };

  const startedAt = performance.now();
  const result = await ingest(fixture.chunk, fixture.taskContext, {
    store,
    classifier: new StubClassifier({
      relevance: fixture.stubs.relevance,
      assessments: fixture.stubs.assessments,
    }),
    writer,
    evaluator,
    classifierPolicy: fixture.classifierPolicy,
    executionPolicy: { ...fixture.executionPolicy, bypassAuditRate: 1 },
    auditDeadlineMs: 10,
    attemptIdFactory: () => "bounded-active",
  });

  expect(result.status).toBe("no_update");
  expect(performance.now() - startedAt).toBeLessThan(500);
  expect(evaluatorCalls).toBe(1);
  expect(store.journal).toContainEqual(
    expect.objectContaining({
      type: "semantic_comparison_failure",
      outcome: "timed_out",
    }),
  );
  expect(store.journal).toContainEqual(
    expect.objectContaining({ type: "audit_record", outcome: "patch" }),
  );
});

test("malformed shadow comparisons are journaled but do not veto the writer commit", async () => {
  const fixture = fixtures.find(
    ({ name }) => name === "same-seed audit assignment",
  );
  if (fixture === undefined) throw new Error("fixture missing");
  const store = new MemoryStore(fixture.initialMemory);
  const patch: MemoryPatch = {
    replacements: [
      {
        topicId: "topic-1" as never,
        expectedVersion: 1,
        title: "Network",
        description: "Network facts",
        summary: "LAN only, confirmed.",
        sources: [{ messageId: "message-same" as never }],
        unresolved: [],
      },
    ],
    newTopics: [],
    addProtected: [],
    supersedeProtected: [],
  };
  const evaluator = {
    async compare() {
      return { verdict: "not-a-verdict", changes: [] };
    },
  } as never;

  const result = await ingest(fixture.chunk, fixture.taskContext, {
    store,
    classifier: new StubClassifier({
      relevance: fixture.stubs.relevance,
      assessments: fixture.stubs.assessments,
    }),
    writer: new StubWriter({ proposals: [{ output: patch }] }),
    evaluator,
    classifierPolicy: fixture.classifierPolicy,
    executionPolicy: { ...fixture.executionPolicy, mode: "shadow" },
    attemptIdFactory: () => "malformed-comparison",
  });

  expect(result.status).toBe("committed");
  expect(store.journal).toContainEqual(
    expect.objectContaining({
      type: "semantic_comparison_failure",
      outcome: "invalid_response",
    }),
  );
});

test("writer-path commits retain their routing reason", async () => {
  const fixture = fixtures.find(
    ({ name }) => name === "low-confidence same-info",
  );
  if (fixture === undefined) throw new Error("fixture missing");
  const store = new MemoryStore(fixture.initialMemory);
  await ingest(fixture.chunk, fixture.taskContext, {
    store,
    classifier: new StubClassifier({
      relevance: fixture.stubs.relevance,
      assessments: fixture.stubs.assessments,
    }),
    writer: new StubWriter({ proposals: fixture.stubs.proposals }),
    classifierPolicy: fixture.classifierPolicy,
    executionPolicy: fixture.executionPolicy,
  });
  expect(store.commits[0]?.journalEntry).toMatchObject({
    reason: "low_confidence_same_info; writer returned empty patch",
  });
});

test("patch escalations are retained with a replayable gate journal", async () => {
  const fixture = fixtures.find(
    ({ name }) => name === "low-confidence same-info",
  );
  if (fixture === undefined) throw new Error("fixture missing");
  const store = new MemoryStore(fixture.initialMemory);
  const result = await ingest(fixture.chunk, fixture.taskContext, {
    store,
    classifier: new StubClassifier({
      relevance: fixture.stubs.relevance,
      assessments: fixture.stubs.assessments,
    }),
    writer: new StubWriter({
      proposals: [
        {
          output: {
            replacements: [
              {
                topicId: "topic-1" as never,
                expectedVersion: 1,
                title: "Network",
                description: "Network facts",
                summary: "Invalid source.",
                sources: [{ messageId: "message-unknown" as never }],
                unresolved: [],
              },
            ],
            newTopics: [],
            addProtected: [],
            supersedeProtected: [],
          },
        },
      ],
    }),
    classifierPolicy: fixture.classifierPolicy,
    executionPolicy: fixture.executionPolicy,
  });
  expect(result.status).toBe("retained");
  expect(store.journal.at(-1)).toMatchObject({
    type: "gate_decision",
    gate: "patch",
    outcome: "escalation",
    classifierPolicy: fixture.classifierPolicy,
    executionPolicy: fixture.executionPolicy,
  });
});

test("fixture-level audit assignment is stable and depends on the seed", async () => {
  const fixture = fixtures.find(
    ({ name }) => name === "same-seed audit assignment",
  );
  if (fixture === undefined) throw new Error("fixture missing");
  const run = async (auditSeed: string): Promise<boolean> => {
    const store = new MemoryStore(fixture.initialMemory);
    await ingest(fixture.chunk, fixture.taskContext, {
      store,
      classifier: new StubClassifier({
        relevance: fixture.stubs.relevance,
        assessments: fixture.stubs.assessments,
      }),
      writer: new StubWriter({ proposals: fixture.stubs.proposals }),
      classifierPolicy: fixture.classifierPolicy,
      executionPolicy: { ...fixture.executionPolicy, auditSeed },
    });
    const audit = store.journal.find((entry) => entry.type === "audit_record");
    return audit?.type === "audit_record" && audit.sampled;
  };
  expect(await run("stable-seed")).toBe(await run("stable-seed"));
  expect(await run("stable-seed")).not.toBe(await run("different-seed"));
});

test("protect matches multiline pins and retains complete tool messages", () => {
  const call = {
    id: "message-call" as never,
    role: "assistant" as const,
    content: "Calling the tool",
    toolCall: { id: "call-1", name: "write", arguments: { path: "/tmp/a" } },
  };
  const resultMessage = {
    id: "message-result" as never,
    role: "tool" as const,
    content: "written",
    toolResult: { callId: "call-1", isError: false },
  };
  const result = protect({
    id: "chunk-protect" as never,
    createdAt: "2026-09-18T00:00:00.000Z",
    messages: [
      call,
      resultMessage,
      {
        id: "message-pin" as never,
        role: "user",
        content: "Preserve this output\nexactly",
      },
    ],
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  expect(result.value).toHaveLength(3);
  expect(JSON.parse(result.value[0]?.text ?? "null")).toEqual(call);
  expect(JSON.parse(result.value[1]?.text ?? "null")).toEqual(resultMessage);
  expect(result.value[2]?.kind).toBe("explicit_pin");
});

test("malformed runtime classifier output is retained", async () => {
  const fixture = fixtures.find(({ name }) => name === "transient chatter");
  if (fixture === undefined) throw new Error("fixture missing");
  const store = new MemoryStore(fixture.initialMemory);
  const classifier = {
    scoreRelevance: async () => ({ topics: "invalid" }),
    classifyRelationships: async () => ({
      relations: [],
      uncovered: { outcome: "none", confidence: 1 },
    }),
  } as never;
  const result = await ingest(fixture.chunk, fixture.taskContext, {
    store,
    classifier,
    writer: new StubWriter(),
    classifierPolicy: fixture.classifierPolicy,
    executionPolicy: { ...fixture.executionPolicy, mode: "active" },
  });
  expect(result).toMatchObject({
    status: "retained",
    reason: expect.stringContaining("malformed relevance response"),
  });
});

test("malformed relationship outcomes cannot authorize a bypass", async () => {
  const fixture = fixtures.find(({ name }) => name === "transient chatter");
  if (fixture === undefined) throw new Error("fixture missing");
  const store = new MemoryStore(fixture.initialMemory);
  const classifier = {
    scoreRelevance: async () => ({
      topics: [{ topicId: fixture.initialMemory.topics[0]?.id, score: 0.9 }],
    }),
    classifyRelationships: async () => ({
      relations: [
        {
          topicId: fixture.initialMemory.topics[0]?.id,
          relationship: "same_info",
          confidence: 0.99,
        },
      ],
      uncovered: { outcome: "invalid", confidence: 0.99 },
    }),
  } as never;
  const result = await ingest(fixture.chunk, fixture.taskContext, {
    store,
    classifier,
    writer: new StubWriter(),
    classifierPolicy: fixture.classifierPolicy,
    executionPolicy: { ...fixture.executionPolicy, mode: "active" },
  });
  expect(result).toMatchObject({
    status: "retained",
    reason: expect.stringContaining("malformed relationship response"),
  });
  expect(store.commits).toHaveLength(0);
});

test("synchronous audit writer throws are recorded and do not block bypass", async () => {
  const fixture = fixtures.find(
    ({ name }) => name === "same-seed audit assignment",
  );
  if (fixture === undefined) throw new Error("fixture missing");
  const store = new MemoryStore(fixture.initialMemory);
  const writer: Writer = {
    propose(): Promise<MemoryPatch> {
      throw new Error("synchronous failure");
    },
    async compress() {
      throw new Error("unused");
    },
  };
  const result = await ingest(fixture.chunk, fixture.taskContext, {
    store,
    classifier: new StubClassifier({
      relevance: fixture.stubs.relevance,
      assessments: fixture.stubs.assessments,
    }),
    writer,
    classifierPolicy: fixture.classifierPolicy,
    executionPolicy: { ...fixture.executionPolicy, bypassAuditRate: 1 },
  });
  expect(result.status).toBe("no_update");
  expect(store.journal[0]).toMatchObject({
    type: "audit_record",
    outcome: "failed",
  });
});

test("malformed writer output reaches the patch gate without dereferencing", async () => {
  const fixture = fixtures.find(({ name }) => name === "timeout");
  if (fixture === undefined) throw new Error("fixture missing");
  const store = new MemoryStore(fixture.initialMemory);
  const writer: Writer = {
    async propose() {
      return {} as MemoryPatch;
    },
    async compress() {
      throw new Error("unused");
    },
  };
  const result = await ingest(fixture.chunk, fixture.taskContext, {
    store,
    classifier: new StubClassifier(),
    writer,
    classifierPolicy: fixture.classifierPolicy,
    executionPolicy: fixture.executionPolicy,
  });
  expect(result.status).toBe("retained");
  expect(store.journal[0]).toMatchObject({
    type: "gate_decision",
    gate: "patch",
  });
});

test("writer records cannot replace deterministic protections", async () => {
  const fixture = fixtures.find(
    ({ name }) => name === "explicit preservation instruction",
  );
  if (fixture === undefined) throw new Error("fixture missing");
  const firstMessage = fixture.chunk.messages[0];
  if (firstMessage === undefined) throw new Error("fixture message missing");
  const protectedId = `protected-${firstMessage.id}-pin`;
  const store = new MemoryStore(fixture.initialMemory);
  const writer = new StubWriter({
    proposals: [
      {
        output: {
          replacements: [],
          newTopics: [],
          addProtected: [
            {
              id: protectedId as never,
              kind: "constraint",
              text: "writer replacement",
              sources: [{ messageId: firstMessage.id }],
              status: "active",
            },
          ],
          supersedeProtected: [],
        },
      },
    ],
  });
  const result = await ingest(fixture.chunk, fixture.taskContext, {
    store,
    classifier: new StubClassifier(),
    writer,
    classifierPolicy: fixture.classifierPolicy,
    executionPolicy: fixture.executionPolicy,
  });
  expect(result.status).toBe("retained");
  expect(store.memory.protected).toHaveLength(0);
  expect(store.journal[0]).toMatchObject({
    type: "gate_decision",
    gate: "patch",
    reason: expect.stringContaining("collides"),
  });
});

class FailingJournalStore extends MemoryStore {
  override async appendJournal(): Promise<Result<void, DomainError>> {
    return err({
      code: "storage_error",
      operation: "appendJournal",
      message: "journal unavailable",
    });
  }
}

class FailingComparisonJournalStore extends MemoryStore {
  override async appendJournal(
    entry: EvaluationJournalEntry,
  ): Promise<Result<void, DomainError>> {
    if (entry.type === "semantic_comparison") {
      return err({
        code: "storage_error",
        operation: "appendJournal",
        message: "comparison journal unavailable",
      });
    }
    return super.appendJournal(entry);
  }
}

test("semantic journal failures stay isolated from a shadow commit", async () => {
  const fixture = fixtures.find(
    ({ name }) => name === "same-seed audit assignment",
  );
  if (fixture === undefined) throw new Error("fixture missing");
  const store = new FailingComparisonJournalStore(fixture.initialMemory);
  const patch: MemoryPatch = {
    replacements: [
      {
        topicId: "topic-1" as never,
        expectedVersion: 1,
        title: "Network",
        description: "Network facts",
        summary: "LAN only, confirmed.",
        sources: [{ messageId: "message-same" as never }],
        unresolved: [],
      },
    ],
    newTopics: [],
    addProtected: [],
    supersedeProtected: [],
  };

  const result = await ingest(fixture.chunk, fixture.taskContext, {
    store,
    classifier: new StubClassifier({
      relevance: fixture.stubs.relevance,
      assessments: fixture.stubs.assessments,
    }),
    writer: new StubWriter({ proposals: [{ output: patch }] }),
    evaluator: new StubEvaluator([
      { output: { verdict: "material_change", changes: [] } },
    ]),
    classifierPolicy: fixture.classifierPolicy,
    executionPolicy: { ...fixture.executionPolicy, mode: "shadow" },
    attemptIdFactory: () => "journal-failure",
  });

  expect(result.status).toBe("committed");
  expect(store.journal).toContainEqual(
    expect.objectContaining({
      type: "semantic_comparison_failure",
      outcome: "failed",
      reason: expect.stringContaining("comparison journal unavailable"),
    }),
  );
});

test("journal persistence failures prevent shadow commits", async () => {
  const fixture = fixtures.find(
    ({ name }) => name === "same-seed audit assignment",
  );
  if (fixture === undefined) throw new Error("fixture missing");
  const store = new FailingJournalStore(fixture.initialMemory);
  const result = await ingest(fixture.chunk, fixture.taskContext, {
    store,
    classifier: new StubClassifier({
      relevance: fixture.stubs.relevance,
      assessments: fixture.stubs.assessments,
    }),
    writer: new StubWriter({ proposals: fixture.stubs.proposals }),
    classifierPolicy: fixture.classifierPolicy,
    executionPolicy: { ...fixture.executionPolicy, mode: "shadow" },
  });
  expect(result).toMatchObject({
    status: "retained",
    reason: expect.stringContaining("shadow routing journal failed"),
  });
  expect(store.commits).toHaveLength(0);
});

test("gate journal failures are surfaced in the retained reason", async () => {
  const fixture = fixtures.find(({ name }) => name === "malformed response");
  if (fixture === undefined) throw new Error("fixture missing");
  const store = new FailingJournalStore(fixture.initialMemory);
  const result = await ingest(fixture.chunk, fixture.taskContext, {
    store,
    classifier: new StubClassifier({ relevance: fixture.stubs.relevance }),
    writer: new StubWriter(),
    classifierPolicy: fixture.classifierPolicy,
    executionPolicy: fixture.executionPolicy,
  });
  expect(result).toMatchObject({
    status: "retained",
    reason: expect.stringContaining("journal failed: journal unavailable"),
  });
});

test("conflicting active and shadow inputs are rejected", async () => {
  const fixture = fixtures.find(({ name }) => name === "transient chatter");
  if (fixture === undefined) throw new Error("fixture missing");
  const store = new MemoryStore(fixture.initialMemory);
  const result = await ingest(fixture.chunk, fixture.taskContext, {
    store,
    classifier: new StubClassifier(),
    writer: new StubWriter(),
    classifierPolicy: fixture.classifierPolicy,
    executionPolicy: { ...fixture.executionPolicy, mode: "shadow" },
    mode: "active",
  });
  expect(result.status).toBe("retained");
  expect(store.journal[0]).toMatchObject({
    type: "gate_decision",
    gate: "configuration",
    effectiveMode: "active",
    executionPolicy: { mode: "active" },
  });
});

test("baseline gate journals record baseline as the effective mode", async () => {
  const fixture = fixtures.find(({ name }) => name === "timeout");
  if (fixture === undefined) throw new Error("fixture missing");
  const store = new MemoryStore(fixture.initialMemory);
  const result = await ingest(fixture.chunk, fixture.taskContext, {
    store,
    classifier: new StubClassifier(),
    writer: new StubWriter({ proposals: [{ error: "failed" }] }),
    classifierPolicy: fixture.classifierPolicy,
    executionPolicy: fixture.executionPolicy,
    mode: "baseline",
  });
  expect(result.status).toBe("retained");
  expect(store.journal[0]).toMatchObject({
    type: "gate_decision",
    gate: "writer",
    effectiveMode: "baseline",
  });
});
