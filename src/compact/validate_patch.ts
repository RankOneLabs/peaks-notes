import {
  type Chunk,
  err,
  type Memory,
  type MemoryPatch,
  MemoryPatchSchema,
  ok,
  type Result,
  type SourceRef,
} from "../schema";
import type { CompactEscalation } from "./select_topics";

const failure = (message: string): Result<never, CompactEscalation> =>
  err({ code: "escalation", gate: "patch", message, policy: {} });

const rangeKey = ({ messageId, start, end }: SourceRef): string =>
  `${messageId}:${start ?? ""}:${end ?? ""}`;

const hasRange = (source: SourceRef): boolean =>
  source.start !== undefined || source.end !== undefined;

/** Older message text is unavailable, so only ranges already in memory carry over. */
const memoryRanges = (memory: Memory): Set<string> =>
  new Set(
    [
      ...memory.topics.flatMap(({ sources }) => sources),
      ...memory.protected.flatMap(({ sources }) => sources),
    ].map(rangeKey),
  );

/**
 * Validates a patch against memory and the chunk. Source ranges are half-open
 * `[start, end)` offsets into the cited message content. With origin "writer",
 * protected records must be verbatim constraint or decision text from the chunk;
 * origin "merged" admits the deterministic records produced by `protect`.
 */
export const validatePatch = (
  memory: Memory,
  chunk: Chunk,
  input: unknown,
  origin: "writer" | "merged" = "writer",
): Result<MemoryPatch, CompactEscalation> => {
  const parsed = MemoryPatchSchema.safeParse(input);
  if (!parsed.success)
    return failure(
      parsed.error.issues.map(({ message }) => message).join("; "),
    );
  const patch = parsed.data;
  const topics = new Map(memory.topics.map((topic) => [topic.id, topic]));
  const sources = new Set([
    ...chunk.messages.map(({ id }) => id),
    ...memory.topics.flatMap((topic) =>
      topic.sources.map(({ messageId }) => messageId),
    ),
    ...memory.protected.flatMap((record) =>
      record.sources.map(({ messageId }) => messageId),
    ),
  ]);
  const chunkContent = new Map(
    chunk.messages.map(({ id, content }) => [id, content]),
  );
  const knownRanges = memoryRanges(memory);
  const replacementIds = new Set<string>();
  for (const replacement of patch.replacements) {
    const current = topics.get(replacement.topicId);
    if (current === undefined)
      return failure(`unknown replacement topic: ${replacement.topicId}`);
    if (replacementIds.has(replacement.topicId))
      return failure(`duplicate replacement topic: ${replacement.topicId}`);
    if (replacement.expectedVersion !== current.version)
      return failure(`stale topic version: ${replacement.topicId}`);
    replacementIds.add(replacement.topicId);
  }
  for (const source of [
    ...patch.replacements.flatMap(({ sources: value }) => value),
    ...patch.newTopics.flatMap(({ sources: value }) => value),
    ...patch.addProtected.flatMap(({ sources: value }) => value),
  ]) {
    if (!sources.has(source.messageId))
      return failure(`unknown source message: ${source.messageId}`);
    const content = chunkContent.get(source.messageId);
    if (content === undefined) {
      if (hasRange(source) && !knownRanges.has(rangeKey(source)))
        return failure(`unverifiable source range: ${source.messageId}`);
    } else if ((source.end ?? source.start ?? 0) > content.length) {
      return failure(`source range out of bounds: ${source.messageId}`);
    }
  }
  const protectedById = new Map(
    memory.protected.map((record) => [record.id, record]),
  );
  const added = new Set<string>();
  for (const record of patch.addProtected) {
    if (protectedById.has(record.id) || added.has(record.id))
      return failure(`duplicate protected record: ${record.id}`);
    added.add(record.id);
    if (origin !== "writer") continue;
    if (record.kind !== "constraint" && record.kind !== "decision")
      return failure(
        `writer cannot add protected ${record.kind}: ${record.id}`,
      );
    if (record.status !== "active")
      return failure(`writer protected record must be active: ${record.id}`);
    if (record.text.length === 0 || record.sources.length === 0)
      return failure(`protected record lacks source text: ${record.id}`);
    for (const source of record.sources) {
      const content = chunkContent.get(source.messageId);
      if (content === undefined)
        return failure(
          `protected record cites message outside chunk: ${record.id}`,
        );
      const verbatim = hasRange(source)
        ? content.slice(source.start ?? 0, source.end) === record.text
        : content.includes(record.text);
      if (!verbatim)
        return failure(`protected record text is not verbatim: ${record.id}`);
    }
  }
  const superseded = new Set<string>();
  for (const supersession of patch.supersedeProtected) {
    const current = protectedById.get(supersession.id);
    if (current === undefined)
      return failure(`unknown protected record: ${supersession.id}`);
    if (superseded.has(supersession.id))
      return failure(`duplicate supersession: ${supersession.id}`);
    superseded.add(supersession.id);
    if (supersession.id === supersession.supersededBy)
      return failure(`protected record cannot supersede itself: ${current.id}`);
    if (
      current.status === "active" &&
      (current.kind === "explicit_pin" || current.kind === "action_receipt")
    )
      return failure(
        `cannot supersede protected ${current.kind}: ${current.id}`,
      );
    if (
      !protectedById.has(supersession.supersededBy) &&
      !added.has(supersession.supersededBy)
    ) {
      return failure(
        `unknown superseding record: ${supersession.supersededBy}`,
      );
    }
  }
  return ok(patch);
};

/** Compression may replace candidate topics only and must retain unresolved work. */
export const validateCompressionPatch = (
  memory: Memory,
  input: unknown,
): Result<MemoryPatch, CompactEscalation> => {
  const parsed = MemoryPatchSchema.safeParse(input);
  if (!parsed.success)
    return failure(
      parsed.error.issues.map(({ message }) => message).join("; "),
    );
  const patch = parsed.data;
  if (
    patch.newTopics.length > 0 ||
    patch.addProtected.length > 0 ||
    patch.supersedeProtected.length > 0
  )
    return failure("compression may replace candidate topics only");
  const topics = new Map(memory.topics.map((topic) => [topic.id, topic]));
  const allowedSources = new Set([
    ...memory.topics.flatMap(({ sources }) =>
      sources.map(({ messageId }) => messageId),
    ),
    ...memory.protected.flatMap(({ sources }) =>
      sources.map(({ messageId }) => messageId),
    ),
  ]);
  const knownRanges = memoryRanges(memory);
  const seen = new Set<string>();
  for (const replacement of patch.replacements) {
    const current = topics.get(replacement.topicId);
    if (current === undefined)
      return failure(`unknown compression topic: ${replacement.topicId}`);
    if (seen.has(replacement.topicId))
      return failure(`duplicate replacement topic: ${replacement.topicId}`);
    if (replacement.expectedVersion !== current.version)
      return failure(`stale topic version: ${replacement.topicId}`);
    seen.add(replacement.topicId);
    const unresolved = new Set(replacement.unresolved);
    if (current.unresolved.some((item) => !unresolved.has(item)))
      return failure(
        `compression omitted unresolved issue: ${replacement.topicId}`,
      );
    if (
      replacement.sources.some(
        ({ messageId }) => !allowedSources.has(messageId),
      )
    )
      return failure(
        `compression introduced unknown source: ${replacement.topicId}`,
      );
    if (
      replacement.sources.some(
        (source) => hasRange(source) && !knownRanges.has(rangeKey(source)),
      )
    )
      return failure(
        `compression introduced unverifiable source range: ${replacement.topicId}`,
      );
  }
  return ok(patch);
};
