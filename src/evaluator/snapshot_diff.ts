import type { Memory, ProtectedRecord, Topic } from "../schema";

export type SnapshotView = {
  topics: Topic[];
  protectedRecords: ProtectedRecord[];
};

const semanticTopic = ({ version: _version, ...topic }: Topic) => topic;

export const memorySemanticallyEqual = (
  before: Memory,
  after: Memory,
): boolean =>
  JSON.stringify({
    topics: before.topics.map(semanticTopic),
    protected: before.protected,
  }) ===
  JSON.stringify({
    topics: after.topics.map(semanticTopic),
    protected: after.protected,
  });

/** Whole affected-set views prevent moved facts from looking like additions/omissions. */
export const buildSnapshotViews = (
  before: Memory,
  after: Memory,
): { before: SnapshotView; after: SnapshotView } => {
  const beforeById = new Map(
    before.topics.map((topic) => [String(topic.id), topic]),
  );
  const afterById = new Map(
    after.topics.map((topic) => [String(topic.id), topic]),
  );
  const affected = new Set<string>();
  for (const id of new Set([...beforeById.keys(), ...afterById.keys()])) {
    const left = beforeById.get(id);
    const right = afterById.get(id);
    if (
      JSON.stringify(left && semanticTopic(left)) !==
      JSON.stringify(right && semanticTopic(right))
    )
      affected.add(id);
  }
  return {
    before: {
      topics: before.topics
        .filter((topic) => affected.has(String(topic.id)))
        .map((topic) => structuredClone(topic)),
      protectedRecords: structuredClone(before.protected),
    },
    after: {
      topics: after.topics
        .filter((topic) => affected.has(String(topic.id)))
        .map((topic) => structuredClone(topic)),
      protectedRecords: structuredClone(after.protected),
    },
  };
};
