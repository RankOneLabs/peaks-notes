import { readFile } from "node:fs/promises";
import { z } from "zod";
import { createConfiguredAdapters } from "../adapters";
import { StubClassifier } from "../classifier/stub";
import { ingest } from "../compact/ingest";
import { loadConfig } from "../config";
import { StubEvaluator } from "../evaluator/stub";
import { ConservativeTokenizer } from "../render/estimate_tokens";
import type {
  Chunk,
  ClassifierPolicy,
  Commit,
  DomainError,
  EvaluationJournalEntry,
  ExecutionPolicy,
  IngestResult,
  JournalEntry,
  Memory,
  Result,
  Topic,
  TopicId,
} from "../schema";
import { ClassifierPolicySchema, ok } from "../schema";
import type { CommitResult, Store } from "../store/store";
import { StubWriter } from "../writer/stub";
import {
  type LoadedFixture,
  loadArchivedJournal,
  loadFixtures,
} from "./load_fixtures";
import { computeMetrics, type MetricsReport } from "./metrics";

export type ReplayAdapterMode = "stub" | "recorded" | "live";

export type ReplayOptions = {
  fixtures?: string;
  journal?: string;
  manifestPath?: string;
  adapters?: ReplayAdapterMode;
  mode?: "shadow" | "active" | "baseline";
  policy?: ClassifierPolicy;
  sweepRecordPath?: string;
  recordedAuditAssignments?: ReadonlyMap<string, boolean>;
};

export type FixtureReplayResult = {
  file: string;
  result: IngestResult;
  revision: number;
  journal: JournalEntry[];
  executionPolicy: ExecutionPolicy;
  classifierPolicy: ClassifierPolicy;
  auditSampled?: boolean;
};

export type ReplayResult = {
  source: string;
  fixtures: FixtureReplayResult[];
  journal: JournalEntry[];
  auditAssignments: Record<string, boolean>;
  metrics: MetricsReport;
  /** Fixtures whose expectations were checked, and those skipped under an override. */
  assertions: { asserted: number; skipped: string[] };
};

class ReplayStore implements Store {
  memory: Memory;
  readonly journal: JournalEntry[] = [];

  constructor(memory: Memory) {
    this.memory = structuredClone(memory);
  }

  async archive(_chunk: Chunk): Promise<Result<void, DomainError>> {
    return ok(undefined);
  }

  async load(): Promise<Result<Memory, DomainError>> {
    return ok(structuredClone(this.memory));
  }

  async commit(
    _expectedRevision: number,
    change: Commit,
  ): Promise<Result<CommitResult, DomainError>> {
    if (this.memory.processedChunkIds.includes(change.chunkId))
      return ok({ status: "replayed", revision: this.memory.revision });
    this.journal.push(structuredClone(change.journalEntry));
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

const defaultPolicy: ClassifierPolicy = {
  relevanceThreshold: 0.5,
  sameInfoMinConfidence: 0.8,
  uncoveredNoChangeMinConfidence: 0.8,
};

const auditAssignments = (
  entries: readonly JournalEntry[],
): Record<string, boolean> => {
  const assignments: Record<string, boolean> = {};
  for (const entry of entries) {
    if (entry.type === "audit_record" && entry.proposedBypass)
      assignments[entry.chunkId] = entry.sampled;
  }
  return assignments;
};

export const reuseRecordedAuditAssignments = (
  entries: readonly JournalEntry[],
): ReadonlyMap<string, boolean> =>
  new Map(Object.entries(auditAssignments(entries)));

const ActiveSweepRecordSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    split: z.literal("dev"),
    chosenPolicy: ClassifierPolicySchema,
  })
  .passthrough();

const loadActivePolicy = async (path: string): Promise<ClassifierPolicy> => {
  try {
    return ActiveSweepRecordSchema.parse(
      JSON.parse(await readFile(path, "utf8")),
    ).chosenPolicy;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `active mode requires a valid recorded threshold sweep: ${path}: ${detail}`,
    );
  }
};

const runFixture = async (
  loaded: LoadedFixture,
  options: ReplayOptions,
): Promise<FixtureReplayResult> => {
  const { fixture } = loaded;
  const store = new ReplayStore(fixture.initialMemory);
  const adapterMode = options.adapters ?? "stub";
  const config = adapterMode === "live" ? loadConfig() : undefined;
  const live =
    config === undefined ? undefined : createConfiguredAdapters(config);
  const auditDeadlineMs =
    fixture.auditDeadlineMs ?? config?.evaluation.auditDeadlineMs;
  const shadowComparisonDeadlineMs =
    fixture.shadowComparisonDeadlineMs ??
    config?.evaluation.shadowComparisonDeadlineMs;
  // Until a standalone trace schema exists, `recorded` intentionally consumes
  // the fixture's checked-in queues through the deterministic adapters. It is
  // an explicit offline alias, not a live-provider configuration.
  const classifier =
    live?.classifier ??
    new StubClassifier({
      relevance: fixture.stubs.relevance,
      assessments: fixture.stubs.assessments,
    });
  const writer =
    live?.writer ??
    new StubWriter({
      proposals: fixture.stubs.proposals,
      compressions: fixture.stubs.compressions,
    });
  const evaluator =
    live?.evaluator ?? new StubEvaluator(fixture.stubs.comparisons);

  const recordedAssignment = options.recordedAuditAssignments?.get(
    fixture.chunk.id,
  );
  const requestedPolicy = {
    ...fixture.executionPolicy,
    ...(options.mode === undefined || options.mode === "baseline"
      ? {}
      : { mode: options.mode }),
  };
  const executionPolicy =
    recordedAssignment === undefined
      ? requestedPolicy
      : { ...requestedPolicy, bypassAuditRate: recordedAssignment ? 1 : 0 };
  const classifierPolicy = options.policy ?? fixture.classifierPolicy;
  const result = await ingest(fixture.chunk, fixture.taskContext, {
    store,
    classifier,
    writer,
    evaluator,
    classifierPolicy,
    executionPolicy,
    budget: {
      maxTokens: fixture.budget?.maxTokens ?? 100_000,
      summaryBudgetTokens: fixture.budget?.summaryBudgetTokens ?? 4_000,
      tokenizer: new ConservativeTokenizer(),
    },
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    ...(auditDeadlineMs === undefined ? {} : { auditDeadlineMs }),
    ...(shadowComparisonDeadlineMs === undefined
      ? {}
      : { shadowComparisonDeadlineMs }),
    ...(fixture.writerDeadlineMs === undefined
      ? {}
      : { writerDeadlineMs: fixture.writerDeadlineMs }),
    attemptIdFactory: () => "replay",
  });
  if (recordedAssignment !== undefined) {
    for (const entry of store.journal) {
      if (entry.type === "audit_record" && entry.chunkId === fixture.chunk.id)
        entry.policy = structuredClone(requestedPolicy);
    }
  }
  const audit = store.journal.find((entry) => entry.type === "audit_record");
  return {
    file: loaded.path,
    result,
    revision: store.memory.revision,
    journal: store.journal,
    executionPolicy,
    classifierPolicy,
    ...(audit?.type === "audit_record" ? { auditSampled: audit.sampled } : {}),
  };
};

/** True when the replay used exactly the mode/policy the fixture was authored with. */
const matchesAuthoredPolicy = (
  loaded: LoadedFixture,
  replay: FixtureReplayResult,
  mode: ReplayOptions["mode"],
): boolean =>
  // A baseline override leaves executionPolicy.mode untouched, so compare the override itself.
  (mode === undefined || mode === loaded.fixture.executionPolicy.mode) &&
  replay.executionPolicy.mode === loaded.fixture.executionPolicy.mode &&
  replay.executionPolicy.bypassAuditRate ===
    loaded.fixture.executionPolicy.bypassAuditRate &&
  replay.executionPolicy.auditSeed ===
    loaded.fixture.executionPolicy.auditSeed &&
  replay.classifierPolicy.relevanceThreshold ===
    loaded.fixture.classifierPolicy.relevanceThreshold &&
  replay.classifierPolicy.sameInfoMinConfidence ===
    loaded.fixture.classifierPolicy.sameInfoMinConfidence &&
  replay.classifierPolicy.uncoveredNoChangeMinConfidence ===
    loaded.fixture.classifierPolicy.uncoveredNoChangeMinConfidence;

export const assertExpected = (
  loaded: LoadedFixture,
  replay: FixtureReplayResult,
): void => {
  if (replay.result.status !== loaded.fixture.expected.status)
    throw new Error(
      `${loaded.path}: expected ${loaded.fixture.expected.status}, received ${replay.result.status}`,
    );
  if (
    loaded.fixture.expected.revision !== undefined &&
    replay.revision !== loaded.fixture.expected.revision
  )
    throw new Error(
      `${loaded.path}: expected revision=${loaded.fixture.expected.revision}, received ${replay.revision}`,
    );
  const reason = "reason" in replay.result ? replay.result.reason : undefined;
  if (
    loaded.fixture.expected.reasonIncludes !== undefined &&
    !reason?.includes(loaded.fixture.expected.reasonIncludes)
  )
    throw new Error(
      `${loaded.path}: expected reason containing ${JSON.stringify(loaded.fixture.expected.reasonIncludes)}, received ${JSON.stringify(reason)}`,
    );
  if (
    loaded.fixture.expected.auditSampled !== undefined &&
    replay.auditSampled !== loaded.fixture.expected.auditSampled
  )
    throw new Error(
      `${loaded.path}: expected audit sampled=${loaded.fixture.expected.auditSampled}, received ${replay.auditSampled}`,
    );
  const audit = replay.journal.find((entry) => entry.type === "audit_record");
  const auditOutcome =
    audit?.type === "audit_record" ? audit.outcome : undefined;
  if (
    loaded.fixture.expected.auditOutcome !== undefined &&
    auditOutcome !== loaded.fixture.expected.auditOutcome
  )
    throw new Error(
      `${loaded.path}: expected audit outcome=${loaded.fixture.expected.auditOutcome}, received ${auditOutcome}`,
    );
};

export const runReplay = async (
  options: ReplayOptions,
): Promise<ReplayResult> => {
  if ((options.fixtures === undefined) === (options.journal === undefined))
    throw new Error("provide exactly one of fixtures or journal");
  const sweepRecordPath =
    options.sweepRecordPath ?? "fixtures/sweep-record.json";
  const recordedPolicy =
    options.mode === "active"
      ? await loadActivePolicy(sweepRecordPath)
      : undefined;
  const selectedPolicy = options.policy ?? recordedPolicy;
  const effectiveOptions =
    selectedPolicy === undefined
      ? options
      : { ...options, policy: selectedPolicy };

  if (options.journal !== undefined) {
    const archive = await loadArchivedJournal(options.journal);
    const policy = selectedPolicy ?? archive.policy ?? defaultPolicy;
    return {
      source: options.journal,
      fixtures: [],
      journal: archive.entries,
      auditAssignments: auditAssignments(archive.entries),
      assertions: { asserted: 0, skipped: [] },
      metrics: computeMetrics({
        entries: archive.entries,
        labels: archive.labels,
        policy,
      }),
    };
  }

  const loaded = await loadFixtures(
    options.fixtures as string,
    options.manifestPath,
  );
  const fixtures: FixtureReplayResult[] = [];
  const skippedAssertions: string[] = [];
  let assertedCount = 0;
  for (const item of loaded) {
    const replay = await runFixture(item, effectiveOptions);
    if (
      (options.adapters ?? "stub") !== "live" &&
      matchesAuthoredPolicy(item, replay, effectiveOptions.mode)
    ) {
      assertExpected(item, replay);
      assertedCount += 1;
    } else {
      skippedAssertions.push(item.path);
    }
    fixtures.push(replay);
  }
  const journal = fixtures.flatMap(({ journal: entries }) => entries);
  return {
    source: options.fixtures as string,
    fixtures,
    journal,
    auditAssignments: auditAssignments(journal),
    assertions: { asserted: assertedCount, skipped: skippedAssertions },
    metrics: computeMetrics({
      entries: journal,
      labels: loaded.map(({ label }) => label),
      policy:
        selectedPolicy ?? loaded[0]?.fixture.classifierPolicy ?? defaultPolicy,
    }),
  };
};
