import type {
  Chunk,
  Commit,
  DomainError,
  EvaluationJournalEntry,
  Memory,
  Result,
  Topic,
  TopicId,
} from "../schema";

export type CommitResult = {
  status: "committed" | "replayed";
  revision: number;
};

/** Spec §7 store contract, extended by §5 evaluation and §4 history requirements. */
export interface Store {
  archive(chunk: Chunk): Promise<Result<void, DomainError>>;
  load(): Promise<Result<Memory, DomainError>>;
  commit(
    expectedRevision: number,
    change: Commit,
  ): Promise<Result<CommitResult, DomainError>>;
  appendJournal(
    entry: EvaluationJournalEntry,
  ): Promise<Result<void, DomainError>>;
  recoverTopicVersions(topicId: TopicId): Promise<Result<Topic[], DomainError>>;
}
