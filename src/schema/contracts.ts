import { z } from "zod";
import { SemanticComparisonSchema } from "./evaluation";
import { MemoryPatchSchema } from "./writer";

export type ResponseContract = {
  name: string;
  version: number;
  schema: Record<string, unknown>;
};

const contract = (name: string, schema: z.ZodType): ResponseContract => ({
  name,
  version: 1,
  schema: z.toJSONSchema(schema, { target: "draft-7" }) as Record<
    string,
    unknown
  >,
});

export const MemoryPatchContract = contract("MemoryPatch", MemoryPatchSchema);
export const SemanticComparisonContract = contract(
  "SemanticComparison",
  SemanticComparisonSchema,
);

export const serializeResponseContract = (value: ResponseContract): string =>
  JSON.stringify(value, null, 2);
