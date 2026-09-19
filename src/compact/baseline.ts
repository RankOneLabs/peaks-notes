import type {
  CallOptions,
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
  options?: CallOptions,
): Promise<MemoryPatch> =>
  writer.propose(
    {
      chunk,
      memory,
      taskContext,
      affectedTopicIds: memory.topics.map(({ id }) => id),
    },
    options,
  );
