import { Database, type SQLQueryBindings } from "bun:sqlite";
import {
  ChunkSchema,
  CommitSchema,
  type DomainError,
  EvaluationJournalEntrySchema,
  err,
  JournalEntrySchema,
  MemorySchema,
  ok,
  type Topic,
  type TopicId,
} from "../schema";
import { migrate } from "./migrations";
import type { CommitResult, Store } from "./store";

type FailureInjector = {
  afterMemoryWrite?: () => void;
};

type RevisionRow = { revision: number; document: string };
type JournalRow = { document: string };

class StaleRevisionError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly actualRevision: number,
  ) {
    super(`expected revision ${expectedRevision}, found ${actualRevision}`);
  }
}

const validationError = (message: string, issues: string[]): DomainError => ({
  code: "validation_error",
  message,
  issues,
});

const storageError = (operation: string, cause: unknown): DomainError => ({
  code: "storage_error",
  operation,
  message: cause instanceof Error ? cause.message : String(cause),
});

const issues = (error: { issues: Array<{ message: string }> }): string[] =>
  error.issues.map((issue) => issue.message);

export class SqliteStore implements Store {
  readonly #database: Database;
  readonly #failureInjector: FailureInjector;

  constructor(path = ":memory:", failureInjector: FailureInjector = {}) {
    this.#database = new Database(path, { create: true, strict: true });
    this.#failureInjector = failureInjector;
    migrate(this.#database);
  }

  close(): void {
    this.#database.close();
  }

  async archive(chunkInput: unknown): ReturnType<Store["archive"]> {
    const parsed = ChunkSchema.safeParse(chunkInput);
    if (!parsed.success) {
      return err(validationError("invalid chunk", issues(parsed.error)));
    }
    try {
      this.#database
        .query(
          "INSERT OR IGNORE INTO chunk_archive (chunk_id, archived_at, document) VALUES (?, ?, ?)",
        )
        .run(
          parsed.data.id,
          new Date().toISOString(),
          JSON.stringify(parsed.data),
        );
      return ok(undefined);
    } catch (cause) {
      return err(storageError("archive", cause));
    }
  }

  async load(): ReturnType<Store["load"]> {
    let row: RevisionRow | null;
    try {
      row = this.#database
        .query<RevisionRow, []>(
          "SELECT revision, document FROM memory_state WHERE singleton = 1",
        )
        .get();
    } catch (cause) {
      return err(storageError("load", cause));
    }
    if (row === null) {
      return err({
        code: "not_found",
        message: "memory is not initialized",
        resource: "memory",
      });
    }
    const parsed = MemorySchema.safeParse(JSON.parse(row.document));
    return parsed.success
      ? ok(parsed.data)
      : err(validationError("stored memory is invalid", issues(parsed.error)));
  }

  async commit(
    expectedRevision: number,
    changeInput: unknown,
  ): ReturnType<Store["commit"]> {
    const parsed = CommitSchema.safeParse(changeInput);
    if (!parsed.success) {
      return err(validationError("invalid commit", issues(parsed.error)));
    }
    const change = parsed.data;
    const consistency = this.#validateCommit(expectedRevision, change);
    if (consistency !== undefined) {
      return err(validationError("inconsistent commit", [consistency]));
    }

    try {
      const transact = this.#database.transaction((): CommitResult => {
        const current = this.#database
          .query<{ revision: number }, []>(
            "SELECT revision FROM memory_state WHERE singleton = 1",
          )
          .get();
        if (current === null) {
          throw new Error("memory is not initialized");
        }
        const replay = this.#database
          .query<{ revision: number }, [SQLQueryBindings]>(
            "SELECT revision FROM processed_chunks WHERE chunk_id = ?",
          )
          .get(change.chunkId);
        if (replay !== null) {
          return { status: "replayed", revision: current.revision };
        }
        if (current.revision !== expectedRevision) {
          throw new StaleRevisionError(expectedRevision, current.revision);
        }

        this.#database
          .query(
            "UPDATE memory_state SET revision = ?, document = ? WHERE singleton = 1 AND revision = ?",
          )
          .run(
            change.memory.revision,
            JSON.stringify(change.memory),
            expectedRevision,
          );
        this.#failureInjector.afterMemoryWrite?.();
        this.#insertJournal(change.journalEntry);
        this.#database
          .query(
            "INSERT INTO processed_chunks (chunk_id, revision, processed_at) VALUES (?, ?, ?)",
          )
          .run(
            change.chunkId,
            change.memory.revision,
            new Date().toISOString(),
          );
        return { status: "committed", revision: change.memory.revision };
      });
      return ok(transact());
    } catch (cause) {
      if (cause instanceof StaleRevisionError) {
        return err({
          code: "stale_revision",
          message: cause.message,
          expectedRevision: cause.expectedRevision,
          actualRevision: cause.actualRevision,
        });
      }
      return err(storageError("commit", cause));
    }
  }

  async appendJournal(entryInput: unknown): ReturnType<Store["appendJournal"]> {
    const parsed = EvaluationJournalEntrySchema.safeParse(entryInput);
    if (!parsed.success) {
      return err(
        validationError(
          "invalid evaluation journal entry",
          issues(parsed.error),
        ),
      );
    }
    try {
      this.#insertJournal(parsed.data);
      return ok(undefined);
    } catch (cause) {
      return err(storageError("appendJournal", cause));
    }
  }

  async recoverTopicVersions(
    topicId: TopicId,
  ): ReturnType<Store["recoverTopicVersions"]> {
    let rows: JournalRow[];
    let memoryRow: RevisionRow | null;
    try {
      rows = this.#database
        .query<JournalRow, []>(
          "SELECT document FROM journal WHERE entry_type = 'committed_update' ORDER BY sequence",
        )
        .all();
      memoryRow = this.#database
        .query<RevisionRow, []>(
          "SELECT revision, document FROM memory_state WHERE singleton = 1",
        )
        .get();
    } catch (cause) {
      return err(storageError("recoverTopicVersions", cause));
    }

    const versions = new Map<number, Topic>();
    for (const row of rows) {
      const entry = JournalEntrySchema.safeParse(JSON.parse(row.document));
      if (!entry.success || entry.data.type !== "committed_update") continue;
      for (const topic of entry.data.previousTopics) {
        if (topic.id === topicId) versions.set(topic.version, topic);
      }
    }
    if (memoryRow !== null) {
      const memory = MemorySchema.safeParse(JSON.parse(memoryRow.document));
      if (memory.success) {
        const current = memory.data.topics.find(
          (topic) => topic.id === topicId,
        );
        if (current !== undefined) versions.set(current.version, current);
      }
    }
    return ok(
      [...versions.values()].sort(
        (left, right) => left.version - right.version,
      ),
    );
  }

  #insertJournal(
    entry:
      | Parameters<Store["appendJournal"]>[0]
      | Parameters<Store["commit"]>[1]["journalEntry"],
  ): void {
    this.#database
      .query(
        "INSERT INTO journal (entry_id, entry_type, chunk_id, snapshot_revision, occurred_at, document) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        entry.id,
        entry.type,
        entry.chunkId,
        entry.snapshotRevision,
        entry.occurredAt,
        JSON.stringify(entry),
      );
  }

  #validateCommit(
    expectedRevision: number,
    change: ReturnType<typeof CommitSchema.parse>,
  ): string | undefined {
    if (change.journalEntry.chunkId !== change.chunkId)
      return "journal chunkId differs from commit chunkId";
    if (change.journalEntry.previousRevision !== expectedRevision)
      return "journal previousRevision differs from expected revision";
    if (change.journalEntry.newRevision !== change.memory.revision)
      return "journal newRevision differs from memory revision";
    const expectedNewRevision =
      change.journalEntry.type === "committed_update"
        ? expectedRevision + 1
        : expectedRevision;
    if (change.memory.revision !== expectedNewRevision)
      return "memory revision does not match commit type";
    if (!change.memory.processedChunkIds.includes(change.chunkId))
      return "memory does not contain processed chunk id";
    return undefined;
  }
}
