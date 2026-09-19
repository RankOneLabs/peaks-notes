import { type SemanticComparison, SemanticComparisonSchema } from "../schema";

export const parseSemanticComparison = (text: string): SemanticComparison => {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    throw new Error("evaluator response is not valid JSON", { cause });
  }
  const parsed = SemanticComparisonSchema.safeParse(value);
  if (!parsed.success)
    throw new Error(
      `evaluator response is invalid: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  if (parsed.data.verdict === "material_change") {
    if (parsed.data.changes.length === 0)
      throw new Error("material_change requires at least one evidenced change");
    parsed.data.changes.forEach((change, index) => {
      if (change.sources.length === 0)
        throw new Error(`material change ${index} requires source refs`);
      if (change.before === null && change.after === null)
        throw new Error(
          `material change ${index} requires before/after evidence`,
        );
      if (change.before !== null && change.before.trim() === "")
        throw new Error(`material change ${index} has empty before evidence`);
      if (change.after !== null && change.after.trim() === "")
        throw new Error(`material change ${index} has empty after evidence`);
    });
  }
  return parsed.data;
};
