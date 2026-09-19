import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { StubClassifier } from "../classifier/stub";
import { LlmEvaluator } from "../evaluator/llm_evaluator";
import { StubEvaluator } from "../evaluator/stub";
import { ConservativeTokenizer } from "../render/estimate_tokens";
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
import { LlmWriter } from "../writer/llm_writer";
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
        budget: {
          maxTokens: fixture.budget?.maxTokens ?? 100_000,
          summaryBudgetTokens: fixture.budget?.summaryBudgetTokens ?? 4_000,
          tokenizer: new ConservativeTokenizer(),
        },
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
        promptVersion: "evaluator-v2",
      },
    }),
  );
});

test("unsampled audit does not reuse metadata from an earlier writer call", async () => {
  const fixture = fixtures.find(
    ({ name }) => name === "same-seed audit assignment",
  );
  if (fixture === undefined) throw new Error("fixture missing");
  let proposeCalls = 0;
  let lastCall:
    | {
        provider: string;
        model: string;
        promptVersion: string;
        usage: {
          inputTokens: number;
          outputTokens: number;
          totalTokens: number;
        };
        latencyMs: number;
      }
    | undefined;
  const writer: Writer & { getLastCall: () => typeof lastCall } = {
    async propose() {
      proposeCalls += 1;
      lastCall = {
        provider: "recorded",
        model: "previous-call",
        promptVersion: "writer-v1",
        usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
        latencyMs: 5,
      };
      return {
        replacements: [],
        newTopics: [],
        addProtected: [],
        supersedeProtected: [],
      };
    },
    async compress() {
      throw new Error("unused");
    },
    getLastCall: () => lastCall,
  };
  await writer.propose({
    chunk: fixture.chunk,
    memory: fixture.initialMemory,
    taskContext: fixture.taskContext,
    affectedTopicIds: [],
  });
  const store = new MemoryStore(fixture.initialMemory);
  await ingest(fixture.chunk, fixture.taskContext, {
    store,
    classifier: new StubClassifier({
      relevance: fixture.stubs.relevance,
      assessments: fixture.stubs.assessments,
    }),
    writer,
    classifierPolicy: fixture.classifierPolicy,
    executionPolicy: {
      ...fixture.executionPolicy,
      mode: "active",
      bypassAuditRate: 0,
    },
  });
  expect(proposeCalls).toBe(1);
  const audit = store.journal.find((entry) => entry.type === "audit_record");
  expect(audit).toMatchObject({ sampled: false, outcome: "not_sampled" });
  expect(audit).not.toHaveProperty("writerModel");
  expect(audit).not.toHaveProperty("writerUsage");
  expect(audit).not.toHaveProperty("writerLatencyMs");
});

test("malformed adapter metadata is not copied into a commit", async () => {
  const fixture = fixtures.find(
    ({ name }) => name === "same-seed audit assignment",
  );
  if (fixture === undefined) throw new Error("fixture missing");
  const topic = fixture.initialMemory.topics[0];
  if (topic === undefined) throw new Error("fixture topic missing");
  const writer: Writer & { getLastCall: () => unknown } = {
    async propose() {
      return {
        replacements: [
          {
            topicId: topic.id,
            expectedVersion: topic.version,
            title: topic.title,
            description: topic.description,
            summary: `${topic.summary} Updated.`,
            sources: [{ messageId: fixture.chunk.messages[0]?.id as never }],
            unresolved: topic.unresolved,
          },
        ],
        newTopics: [],
        addProtected: [],
        supersedeProtected: [],
      };
    },
    async compress() {
      throw new Error("unused");
    },
    getLastCall: () => ({ provider: "unchecked", latencyMs: -1 }),
  };
  const store = new MemoryStore(fixture.initialMemory);
  await ingest(fixture.chunk, fixture.taskContext, {
    store,
    classifier: new StubClassifier(),
    writer,
    classifierPolicy: fixture.classifierPolicy,
    executionPolicy: fixture.executionPolicy,
    mode: "baseline",
  });
  const commit = store.commits.find(
    (candidate) => candidate.type === "committed_update",
  );
  expect(commit?.type).toBe("committed_update");
  if (commit?.type !== "committed_update") throw new Error("commit missing");
  expect(commit.journalEntry.writerModel.provider).toBe("stub");
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
  expect(
    store.journal.find(({ type }) => type === "audit_record"),
  ).toMatchObject({
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
  expect(
    store.journal.find(({ type }) => type === "audit_record"),
  ).toMatchObject({
    type: "audit_record",
    outcome: "patch",
  });
});

test("failed audited writer requests emit canonical call events", async () => {
  const fixture = fixtures.find(
    ({ name }) => name === "same-seed audit assignment",
  );
  if (fixture === undefined) throw new Error("fixture missing");
  const store = new MemoryStore(fixture.initialMemory);
  const writer = new LlmWriter(
    new RecordedProvider([{ error: new Error("provider unavailable") }]),
    {
      provider: "openai",
      apiKey: "unused",
      model: "audit-writer",
      deadlineMs: 100,
      promptVersion: "writer-v3",
      maxInputTokens: 32_000,
    },
  );

  await ingest(fixture.chunk, fixture.taskContext, {
    store,
    classifier: new StubClassifier({
      relevance: fixture.stubs.relevance,
      assessments: fixture.stubs.assessments,
    }),
    writer,
    classifierPolicy: fixture.classifierPolicy,
    executionPolicy: { ...fixture.executionPolicy, bypassAuditRate: 1 },
    attemptIdFactory: () => "failed-audit-writer",
  });

  expect(store.journal).toContainEqual(
    expect.objectContaining({
      type: "model_call",
      role: "writer",
      operation: "propose",
      status: "failed",
      attemptId: "failed-audit-writer",
    }),
  );
});

test("timed-out audited writer requests emit canonical call events", async () => {
  const fixture = fixtures.find(
    ({ name }) => name === "same-seed audit assignment",
  );
  if (fixture === undefined) throw new Error("fixture missing");
  const store = new MemoryStore(fixture.initialMemory);
  const writer = new LlmWriter(
    { id: "never", generate: () => new Promise(() => {}) },
    {
      provider: "openai",
      apiKey: "unused",
      model: "audit-writer",
      deadlineMs: 2,
      promptVersion: "writer-v3",
      maxInputTokens: 32_000,
    },
  );

  await ingest(fixture.chunk, fixture.taskContext, {
    store,
    classifier: new StubClassifier({
      relevance: fixture.stubs.relevance,
      assessments: fixture.stubs.assessments,
    }),
    writer,
    classifierPolicy: fixture.classifierPolicy,
    executionPolicy: { ...fixture.executionPolicy, bypassAuditRate: 1 },
    auditDeadlineMs: 100,
    attemptIdFactory: () => "timed-out-audit-writer",
  });

  expect(store.journal).toContainEqual(
    expect.objectContaining({
      type: "model_call",
      role: "writer",
      operation: "propose",
      status: "timed_out",
      attemptId: "timed-out-audit-writer",
      usageProvenance: "unknown",
    }),
  );
});

test("failed evaluator requests emit canonical call events", async () => {
  const fixture = fixtures.find(
    ({ name }) => name === "same-seed audit assignment",
  );
  if (fixture === undefined) throw new Error("fixture missing");
  const store = new MemoryStore(fixture.initialMemory);
  const evaluator = new LlmEvaluator(
    new RecordedProvider([{ error: new Error("provider unavailable") }]),
    {
      provider: "openai",
      apiKey: "unused",
      model: "audit-evaluator",
      deadlineMs: 100,
      promptVersion: "unused",
      maxInputTokens: 32_000,
    },
  );
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

  await ingest(fixture.chunk, fixture.taskContext, {
    store,
    classifier: new StubClassifier({
      relevance: fixture.stubs.relevance,
      assessments: fixture.stubs.assessments,
    }),
    writer,
    evaluator,
    classifierPolicy: fixture.classifierPolicy,
    executionPolicy: { ...fixture.executionPolicy, bypassAuditRate: 1 },
    attemptIdFactory: () => "failed-audit-evaluator",
  });

  expect(store.journal).toContainEqual(
    expect.objectContaining({
      type: "model_call",
      role: "evaluator",
      operation: "compare",
      status: "failed",
      attemptId: "failed-audit-evaluator",
    }),
  );
  expect(store.journal).toContainEqual(
    expect.objectContaining({
      type: "semantic_comparison_failure",
      outcome: "failed",
    }),
  );
});

test("invalid and uncertain evaluator responses emit canonical call events", async () => {
  const fixture = fixtures.find(
    ({ name }) => name === "same-seed audit assignment",
  );
  if (fixture === undefined) throw new Error("fixture missing");
  const cases = [
    {
      name: "invalid",
      text: JSON.stringify({ verdict: "invalid", changes: [] }),
      status: "failed",
    },
    {
      name: "uncertain",
      text: JSON.stringify({ verdict: "uncertain", changes: [] }),
      status: "succeeded",
    },
  ] as const;

  for (const evaluatorCase of cases) {
    const store = new MemoryStore(fixture.initialMemory);
    const evaluator = new LlmEvaluator(
      new RecordedProvider([
        {
          response: {
            text: evaluatorCase.text,
            model: "audit-evaluator",
            usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
          },
        },
      ]),
      {
        provider: "openai",
        apiKey: "unused",
        model: "audit-evaluator",
        deadlineMs: 100,
        promptVersion: "unused",
        maxInputTokens: 32_000,
      },
    );
    await ingest(fixture.chunk, fixture.taskContext, {
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
      }),
      evaluator,
      classifierPolicy: fixture.classifierPolicy,
      executionPolicy: { ...fixture.executionPolicy, bypassAuditRate: 1 },
      attemptIdFactory: () => `${evaluatorCase.name}-audit-evaluator`,
    });

    expect(store.journal).toContainEqual(
      expect.objectContaining({
        type: "model_call",
        role: "evaluator",
        operation: "compare",
        status: evaluatorCase.status,
        attemptId: `${evaluatorCase.name}-audit-evaluator`,
      }),
    );
  }
});

test("timed-out evaluator requests emit canonical call events", async () => {
  const fixture = fixtures.find(
    ({ name }) => name === "same-seed audit assignment",
  );
  if (fixture === undefined) throw new Error("fixture missing");
  const store = new MemoryStore(fixture.initialMemory);
  const evaluator = new LlmEvaluator(
    { id: "never", generate: () => new Promise(() => {}) },
    {
      provider: "openai",
      apiKey: "unused",
      model: "audit-evaluator",
      deadlineMs: 100,
      promptVersion: "unused",
      maxInputTokens: 32_000,
    },
  );

  await ingest(fixture.chunk, fixture.taskContext, {
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
    }),
    evaluator,
    classifierPolicy: fixture.classifierPolicy,
    executionPolicy: { ...fixture.executionPolicy, bypassAuditRate: 1 },
    auditDeadlineMs: 20,
    attemptIdFactory: () => "timed-out-audit-evaluator",
  });

  expect(store.journal).toContainEqual(
    expect.objectContaining({
      type: "model_call",
      role: "evaluator",
      operation: "compare",
      status: "timed_out",
      attemptId: "timed-out-audit-evaluator",
      usageProvenance: "unknown",
    }),
  );
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
  expect(
    store.journal.find(({ type }) => type === "audit_record"),
  ).toMatchObject({
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
  expect(
    store.journal.find(({ type }) => type === "gate_decision"),
  ).toMatchObject({
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
              text: firstMessage.content,
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
  expect(
    store.journal.find(({ type }) => type === "gate_decision"),
  ).toMatchObject({
    type: "gate_decision",
    gate: "patch",
    reason: expect.stringContaining("collides"),
  });
});

test("fabricated writer protected text is rejected while deterministic pins commit", async () => {
  const fixture = fixtures.find(
    ({ name }) => name === "explicit preservation instruction",
  );
  if (fixture === undefined) throw new Error("fixture missing");
  const firstMessage = fixture.chunk.messages[0];
  if (firstMessage === undefined) throw new Error("fixture message missing");
  const run = async (text: string) => {
    const store = new MemoryStore(fixture.initialMemory);
    const result = await ingest(fixture.chunk, fixture.taskContext, {
      store,
      classifier: new StubClassifier(),
      writer: new StubWriter({
        proposals: [
          {
            output: {
              replacements: [],
              newTopics: [],
              addProtected: [
                {
                  id: "writer-constraint" as never,
                  kind: "constraint",
                  text,
                  sources: [{ messageId: firstMessage.id }],
                  status: "active",
                },
              ],
              supersedeProtected: [],
            },
          },
        ],
      }),
      classifierPolicy: fixture.classifierPolicy,
      executionPolicy: fixture.executionPolicy,
    });
    return { store, result };
  };
  const fabricated = await run("the user never said this");
  expect(fabricated.result.status).toBe("retained");
  expect(fabricated.store.memory.protected).toHaveLength(0);
  expect(
    fabricated.store.journal.find(({ type }) => type === "gate_decision"),
  ).toMatchObject({ reason: expect.stringContaining("not verbatim") });
  const verbatim = await run(firstMessage.content);
  expect(verbatim.result.status).toBe("committed");
  expect(verbatim.store.memory.protected.map(({ kind }) => kind)).toEqual([
    "explicit_pin",
    "constraint",
  ]);
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
    reason: expect.stringContaining("routing journal failed"),
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
  expect(
    store.journal.find(({ type }) => type === "gate_decision"),
  ).toMatchObject({
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
  expect(
    store.journal.find(({ type }) => type === "gate_decision"),
  ).toMatchObject({
    type: "gate_decision",
    gate: "writer",
    effectiveMode: "baseline",
  });
});

const bypassFixture = () => {
  const fixture = fixtures.find(
    ({ name }) => name === "same-seed audit assignment",
  );
  if (fixture === undefined) throw new Error("fixture missing");
  return fixture;
};
const writerConfig = {
  provider: "openai" as const,
  apiKey: "unused",
  model: "writer",
  deadlineMs: 1_000,
  promptVersion: "writer-v3",
  maxInputTokens: 32_000,
};
const emptyPatchText = JSON.stringify({
  replacements: [],
  newTopics: [],
  addProtected: [],
  supersedeProtected: [],
});
const usage = (inputTokens: number) => ({
  inputTokens,
  outputTokens: 1,
  totalTokens: inputTokens + 1,
});

test("a deadline aborts the audit call and leaves later call records alone", async () => {
  const fixture = bypassFixture();
  const signals: Array<AbortSignal | undefined> = [];
  const writer = new LlmWriter(
    {
      id: "slow-then-fast",
      generate: (request) => {
        signals.push(request.signal);
        return signals.length === 1
          ? new Promise(() => {})
          : Promise.resolve({
              text: emptyPatchText,
              usage: usage(7),
              model: "second-call",
            });
      },
    },
    writerConfig,
  );
  const store = new MemoryStore(fixture.initialMemory);
  await ingest(fixture.chunk, fixture.taskContext, {
    store,
    classifier: new StubClassifier({
      relevance: fixture.stubs.relevance,
      assessments: fixture.stubs.assessments,
    }),
    writer,
    classifierPolicy: fixture.classifierPolicy,
    executionPolicy: { ...fixture.executionPolicy, bypassAuditRate: 1 },
    auditDeadlineMs: 5,
    attemptIdFactory: () => "aborted-audit",
  });
  expect(signals[0]?.aborted).toBe(true);
  expect(store.journal).toContainEqual(
    expect.objectContaining({
      type: "model_call",
      id: expect.stringContaining("model-writer-audit-propose"),
      status: "timed_out",
      usageProvenance: "unknown",
    }),
  );
  expect(writer.getActiveCall()).toBeUndefined();
  expect(writer.getLastCall()).toBeUndefined();

  await writer.propose({
    chunk: fixture.chunk,
    memory: fixture.initialMemory,
    taskContext: fixture.taskContext,
    affectedTopicIds: [],
  });
  await new Promise((done) => setTimeout(done, 5));
  expect(writer.getLastCall()).toMatchObject({
    model: "second-call",
    usage: usage(7),
  });
});

const longTokenizer = {
  count: (text: string) => ({
    tokens: text.includes("LONG") ? 100 : 1,
    method: "target_tokenizer" as const,
  }),
};
const budget = {
  maxTokens: 1_000,
  summaryBudgetTokens: 10,
  tokenizer: longTokenizer,
};
const replaceNetwork = (summary: string, expectedVersion = 1) =>
  JSON.stringify({
    replacements: [
      {
        topicId: "topic-1",
        expectedVersion,
        title: "Network",
        description: "Network facts",
        summary,
        sources: [{ messageId: "message-old" }],
        unresolved: [],
      },
    ],
    newTopics: [],
    addProtected: [],
    supersedeProtected: [],
  });

test("a compression timeout journals the compress call, not the earlier propose", async () => {
  const fixture = bypassFixture();
  let calls = 0;
  const writer = new LlmWriter(
    {
      id: "propose-then-hang",
      generate: () => {
        calls += 1;
        return calls === 1
          ? Promise.resolve({
              text: replaceNetwork("LONG network notes"),
              usage: usage(40),
              model: "writer",
            })
          : new Promise(() => {});
      },
    },
    writerConfig,
  );
  const store = new MemoryStore(fixture.initialMemory);
  const result = await ingest(fixture.chunk, fixture.taskContext, {
    store,
    classifier: new StubClassifier(),
    writer,
    classifierPolicy: fixture.classifierPolicy,
    executionPolicy: fixture.executionPolicy,
    mode: "baseline",
    budget: { ...budget, compressionDeadlineMs: 5 },
    attemptIdFactory: () => "compress-timeout",
  });
  expect(result.status).toBe("retained");
  const modelCalls = store.journal.filter(({ type }) => type === "model_call");
  expect(modelCalls).toHaveLength(2);
  expect(modelCalls[0]).toMatchObject({
    operation: "propose",
    status: "succeeded",
    usage: usage(40),
  });
  expect(modelCalls[1]).toMatchObject({
    operation: "compress",
    status: "timed_out",
    usageProvenance: "unknown",
  });
  expect(modelCalls[1]).not.toHaveProperty("usage");
});

test("a bypass that compresses is still audited before it commits", async () => {
  const fixture = bypassFixture();
  const memory = structuredClone(fixture.initialMemory);
  const topic = memory.topics[0];
  if (topic === undefined) throw new Error("fixture topic missing");
  topic.summary = "LONG LAN only.";
  const writer = new LlmWriter(
    new RecordedProvider(
      [
        replaceNetwork("LAN only."),
        replaceNetwork("LONG audited rewrite"),
        replaceNetwork("Audited rewrite.", 2),
      ].map((text, index) => ({
        response: { text, usage: usage(10 + index), model: "writer" },
      })),
    ),
    writerConfig,
  );
  const store = new MemoryStore(memory);
  const result = await ingest(fixture.chunk, fixture.taskContext, {
    store,
    classifier: new StubClassifier({
      relevance: fixture.stubs.relevance,
      assessments: fixture.stubs.assessments,
    }),
    writer,
    classifierPolicy: fixture.classifierPolicy,
    executionPolicy: { ...fixture.executionPolicy, bypassAuditRate: 1 },
    budget,
    attemptIdFactory: () => "audited-compression",
  });
  expect(result.status).toBe("committed");
  expect(store.memory.topics[0]?.summary).toBe("LAN only.");
  const audits = store.journal.filter(({ type }) => type === "audit_record");
  expect(audits).toHaveLength(1);
  expect(audits[0]).toMatchObject({ sampled: true, outcome: "patch" });
  const ids = store.journal.map(({ id }) => id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(
    store.journal
      .filter(({ type }) => type === "model_call")
      .map(({ id }) => id.replace(/^.*-model-/, "")),
  ).toEqual([
    "writer-compress",
    "writer-audit-compress",
    "writer-audit-propose",
  ]);
});

const storageError = (operation: string) =>
  err({
    code: "storage_error" as const,
    operation,
    message: `${operation} unavailable`,
  });

test.each(["archive", "load", "commit"] as const)(
  "a failing store %s retains the chunk",
  async (operation) => {
    const fixture = bypassFixture();
    const store = new MemoryStore(fixture.initialMemory);
    store[operation] = async () => storageError(operation);
    const result = await ingest(fixture.chunk, fixture.taskContext, {
      store,
      classifier: new StubClassifier(),
      writer: new StubWriter({ proposals: fixture.stubs.proposals }),
      classifierPolicy: fixture.classifierPolicy,
      executionPolicy: fixture.executionPolicy,
      mode: "baseline",
    });
    expect(result).toMatchObject({
      status: "retained",
      reason: expect.stringContaining(`${operation} unavailable`),
    });
    expect(store.commits).toHaveLength(0);
  },
);

test("a timed-out writer call that cannot be journaled retains the chunk", async () => {
  const fixture = bypassFixture();
  const store = new MemoryStore(fixture.initialMemory);
  const appendJournal = store.appendJournal.bind(store);
  store.appendJournal = async (entry) =>
    entry.type === "model_call"
      ? storageError("appendJournal")
      : appendJournal(entry);
  const result = await ingest(fixture.chunk, fixture.taskContext, {
    store,
    classifier: new StubClassifier(),
    writer: new LlmWriter(
      { id: "never", generate: () => new Promise(() => {}) },
      writerConfig,
    ),
    classifierPolicy: fixture.classifierPolicy,
    executionPolicy: fixture.executionPolicy,
    mode: "baseline",
    writerDeadlineMs: 5,
  });
  expect(result).toMatchObject({
    status: "retained",
    reason: expect.stringContaining("writer call journal failed"),
  });
});
