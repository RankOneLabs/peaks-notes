import { type MemoryPatch, MemoryPatchSchema, type SourceRef } from "../schema";

const wholeMessage = ({ messageId }: SourceRef): SourceRef => ({ messageId });

/**
 * Model-generated character offsets are guesses and cannot be trusted as
 * provenance. Keep the cited message while leaving exact ranges to
 * deterministic host protections.
 */
const normalizeWriterSources = (patch: MemoryPatch): MemoryPatch => ({
  ...patch,
  replacements: patch.replacements.map((replacement) => ({
    ...replacement,
    sources: replacement.sources.map(wholeMessage),
  })),
  newTopics: patch.newTopics.map((topic) => ({
    ...topic,
    sources: topic.sources.map(wholeMessage),
  })),
  addProtected: patch.addProtected.map((record) => ({
    ...record,
    sources: record.sources.map(wholeMessage),
  })),
});

export const parseMemoryPatch = (text: string): MemoryPatch => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new Error("writer response is not valid JSON", { cause });
  }
  const parsed = MemoryPatchSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `writer response is not a MemoryPatch: ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }
  return normalizeWriterSources(parsed.data);
};
