import type {
  Chunk,
  Memory,
  MemoryPatch,
  TaskContext,
  Writer,
} from "../schema";

/** Always-writer comparison baseline, independent of classifier output. */
export const runBaseline = async (
  writer: Writer,
  chunk: Chunk,
  memory: Memory,
  taskContext: TaskContext,
): Promise<MemoryPatch> =>
  writer.propose({
    chunk,
    memory,
    taskContext,
    affectedTopicIds: memory.topics.map(({ id }) => id),
  });
