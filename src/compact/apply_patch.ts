import type { ChunkId, Memory, MemoryPatch, TopicId } from "../schema";

export type TopicIdFactory = (index: number) => TopicId;

export const applyPatch = (
  memory: Memory,
  patch: MemoryPatch,
  chunkId?: ChunkId,
  makeTopicId?: TopicIdFactory,
): Memory => {
  const replacements = new Map(
    patch.replacements.map((item) => [item.topicId, item]),
  );
  const supersessions = new Map(
    patch.supersedeProtected.map((item) => [item.id, item.supersededBy]),
  );
  const occupiedTopicIds = new Set(memory.topics.map(({ id }) => String(id)));
  let nextTopicOrdinal = 1;
  const allocateTopicId = (index: number): TopicId => {
    if (makeTopicId !== undefined) {
      const id = makeTopicId(index);
      if (occupiedTopicIds.has(id))
        throw new Error(`duplicate generated topic id: ${id}`);
      occupiedTopicIds.add(id);
      return id;
    }
    let candidate = `topic-${memory.revision + 1}-${nextTopicOrdinal}`;
    while (occupiedTopicIds.has(candidate)) {
      nextTopicOrdinal += 1;
      candidate = `topic-${memory.revision + 1}-${nextTopicOrdinal}`;
    }
    nextTopicOrdinal += 1;
    occupiedTopicIds.add(candidate);
    return candidate as TopicId;
  };
  return {
    revision: memory.revision + 1,
    topics: [
      ...memory.topics.map((topic) => {
        const replacement = replacements.get(topic.id);
        return replacement === undefined
          ? structuredClone(topic)
          : {
              id: topic.id,
              version: topic.version + 1,
              title: replacement.title,
              description: replacement.description,
              summary: replacement.summary,
              sources: structuredClone(replacement.sources),
              unresolved: [...replacement.unresolved],
            };
      }),
      ...patch.newTopics.map((topic, index) => ({
        ...structuredClone(topic),
        id: allocateTopicId(index),
        version: 1,
      })),
    ],
    protected: [
      ...memory.protected.map((record) => {
        const supersededBy = supersessions.get(record.id);
        return supersededBy === undefined
          ? structuredClone(record)
          : {
              ...structuredClone(record),
              status: "superseded" as const,
              supersededBy,
            };
      }),
      ...structuredClone(patch.addProtected),
    ],
    processedChunkIds:
      chunkId === undefined || memory.processedChunkIds.includes(chunkId)
        ? [...memory.processedChunkIds]
        : [...memory.processedChunkIds, chunkId],
  };
};
