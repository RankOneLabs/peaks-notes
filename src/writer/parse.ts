import { MemoryPatchSchema, type MemoryPatch } from "../schema";

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
  return parsed.data;
};
