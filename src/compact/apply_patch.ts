import type { ChunkId, Memory, MemoryPatch, TopicId } from "../schema";

export type TopicIdFactory = (index: number) => TopicId;

export const applyPatch = (
  memory: Memory,
  patch: MemoryPatch,
  chunkId?: ChunkId,
  makeTopicId: TopicIdFactory = (index) => `topic-${memory.revision + 1}-${index + 1}` as TopicId,
): Memory => {
  const replacements = new Map(patch.replacements.map((item) => [item.topicId, item]));
  const supersessions = new Map(patch.supersedeProtected.map((item) => [item.id, item.supersededBy]));
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
        id: makeTopicId(index),
        version: 1,
      })),
    ],
    protected: [
      ...memory.protected.map((record) => {
        const supersededBy = supersessions.get(record.id);
        return supersededBy === undefined
          ? structuredClone(record)
          : { ...structuredClone(record), status: "superseded" as const, supersededBy };
      }),
      ...structuredClone(patch.addProtected),
    ],
    processedChunkIds:
      chunkId === undefined || memory.processedChunkIds.includes(chunkId)
        ? [...memory.processedChunkIds]
        : [...memory.processedChunkIds, chunkId],
  };
};
