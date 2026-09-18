import {
  MemoryPatchSchema,
  type Chunk,
  type Memory,
  type MemoryPatch,
  type Result,
} from "../schema";
import { err, ok } from "../schema";
import type { CompactEscalation } from "./select_topics";

const failure = (message: string): Result<never, CompactEscalation> =>
  err({ code: "escalation", gate: "patch", message, policy: {} });

export const validatePatch = (
  memory: Memory,
  chunk: Chunk,
  input: unknown,
): Result<MemoryPatch, CompactEscalation> => {
  const parsed = MemoryPatchSchema.safeParse(input);
  if (!parsed.success) return failure(parsed.error.issues.map(({ message }) => message).join("; "));
  const patch = parsed.data;
  const topics = new Map(memory.topics.map((topic) => [topic.id, topic]));
  const sources = new Set([
    ...chunk.messages.map(({ id }) => id),
    ...memory.topics.flatMap((topic) => topic.sources.map(({ messageId }) => messageId)),
    ...memory.protected.flatMap((record) => record.sources.map(({ messageId }) => messageId)),
  ]);
  const replacementIds = new Set<string>();
  for (const replacement of patch.replacements) {
    const current = topics.get(replacement.topicId);
    if (current === undefined) return failure(`unknown replacement topic: ${replacement.topicId}`);
    if (replacementIds.has(replacement.topicId)) return failure(`duplicate replacement topic: ${replacement.topicId}`);
    if (replacement.expectedVersion !== current.version) return failure(`stale topic version: ${replacement.topicId}`);
    replacementIds.add(replacement.topicId);
  }
  for (const source of [
    ...patch.replacements.flatMap(({ sources: value }) => value),
    ...patch.newTopics.flatMap(({ sources: value }) => value),
    ...patch.addProtected.flatMap(({ sources: value }) => value),
  ]) {
    if (!sources.has(source.messageId)) return failure(`unknown source message: ${source.messageId}`);
  }
  const protectedById = new Map(memory.protected.map((record) => [record.id, record]));
  const added = new Set(patch.addProtected.map(({ id }) => id));
  for (const record of patch.addProtected) {
    if (protectedById.has(record.id)) return failure(`duplicate protected record: ${record.id}`);
  }
  for (const supersession of patch.supersedeProtected) {
    const current = protectedById.get(supersession.id);
    if (current === undefined) return failure(`unknown protected record: ${supersession.id}`);
    if (current.kind === "explicit_pin" && current.status === "active") return failure(`cannot supersede explicit pin: ${current.id}`);
    if (!protectedById.has(supersession.supersededBy) && !added.has(supersession.supersededBy)) {
      return failure(`unknown superseding record: ${supersession.supersededBy}`);
    }
  }
  return ok(patch);
};
