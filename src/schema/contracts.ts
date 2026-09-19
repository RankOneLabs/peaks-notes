import { z } from "zod";
import { SemanticComparisonSchema } from "./evaluation";
import { WriterMemoryPatchSchema } from "./writer";

export type ResponseContract = {
  name: string;
  version: number;
  schema: Record<string, unknown>;
};

type JsonSchema = Record<string, unknown>;

const schemaObject = (value: unknown): JsonSchema | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonSchema)
    : undefined;

const withoutUnsupportedConstraints = (schema: JsonSchema): JsonSchema => {
  const unsupported = new Set([
    "$schema",
    "exclusiveMaximum",
    "exclusiveMinimum",
    "maxItems",
    "maxLength",
    "maximum",
    "minLength",
    "minimum",
    "multipleOf",
  ]);
  return Object.fromEntries(
    Object.entries(schema).flatMap(([key, value]) => {
      if (unsupported.has(key)) return [];
      if (Array.isArray(value))
        return [
          [
            key,
            value.map((item) => {
              const nested = schemaObject(item);
              return nested === undefined
                ? item
                : withoutUnsupportedConstraints(nested);
            }),
          ],
        ];
      const nested = schemaObject(value);
      return [
        [
          key,
          nested === undefined ? value : withoutUnsupportedConstraints(nested),
        ],
      ];
    }),
  );
};

const nullable = (schema: JsonSchema): JsonSchema => {
  if (Array.isArray(schema.type)) {
    const types = schema.type.includes("null")
      ? schema.type
      : [...schema.type, "null"];
    return {
      ...schema,
      type: types,
      ...(Array.isArray(schema.enum) && !schema.enum.includes(null)
        ? { enum: [...schema.enum, null] }
        : {}),
    };
  }
  if (typeof schema.type === "string")
    return {
      ...schema,
      type: [schema.type, "null"],
      ...(Array.isArray(schema.enum) && !schema.enum.includes(null)
        ? { enum: [...schema.enum, null] }
        : {}),
    };
  if (Array.isArray(schema.anyOf))
    return {
      ...schema,
      anyOf: [...schema.anyOf, { type: "null" }],
    };
  return { anyOf: [schema, { type: "null" }] };
};

const requireAllProperties = (schema: JsonSchema): JsonSchema => {
  const cleaned = withoutUnsupportedConstraints(schema);
  const properties = schemaObject(cleaned.properties);
  if (properties === undefined) return cleaned;
  const originallyRequired = new Set(
    Array.isArray(cleaned.required)
      ? cleaned.required.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
  );
  const transformed = Object.fromEntries(
    Object.entries(properties).map(([key, value]) => {
      const property = schemaObject(value);
      if (property === undefined) return [key, value];
      const nested = requireAllProperties(property);
      return [key, originallyRequired.has(key) ? nested : nullable(nested)];
    }),
  );
  return {
    ...cleaned,
    properties: transformed,
    required: Object.keys(properties),
    additionalProperties: false,
  };
};

const mapNestedSchemas = (schema: JsonSchema): JsonSchema => {
  const mapped = Object.fromEntries(
    Object.entries(schema).map(([key, value]) => {
      if (Array.isArray(value))
        return [
          key,
          value.map((item) => {
            const nested = schemaObject(item);
            return nested === undefined ? item : mapNestedSchemas(nested);
          }),
        ];
      const nested = schemaObject(value);
      return [key, nested === undefined ? value : mapNestedSchemas(nested)];
    }),
  );
  return requireAllProperties(mapped);
};

/** OpenAI strict outputs require every object property and emulate optionals with null. */
export const openAIStrictResponseSchema = (schema: JsonSchema): JsonSchema =>
  mapNestedSchemas(structuredClone(schema));

/** Anthropic accepts optional properties but rejects several validation-only keywords. */
export const anthropicResponseSchema = (schema: JsonSchema): JsonSchema =>
  withoutUnsupportedConstraints(structuredClone(schema));

const removeOptionalNulls = (value: unknown, schema: JsonSchema): unknown => {
  if (Array.isArray(value)) {
    const itemSchema = schemaObject(schema.items);
    return itemSchema === undefined
      ? value
      : value.map((item) => removeOptionalNulls(item, itemSchema));
  }
  const object = schemaObject(value);
  const properties = schemaObject(schema.properties);
  if (object === undefined || properties === undefined) return value;
  const required = new Set(
    Array.isArray(schema.required)
      ? schema.required.filter(
          (item): item is string => typeof item === "string",
        )
      : [],
  );
  return Object.fromEntries(
    Object.entries(object).flatMap(([key, child]) => {
      const childSchema = schemaObject(properties[key]);
      if (childSchema === undefined) return [[key, child]];
      if (!required.has(key) && child === null) return [];
      return [[key, removeOptionalNulls(child, childSchema)]];
    }),
  );
};

/** Restores the original optional-property shape before domain parsing. */
export const normalizeOpenAIStrictResponse = (
  text: string,
  schema: JsonSchema,
): string => {
  try {
    const parsed: unknown = JSON.parse(text);
    return JSON.stringify(removeOptionalNulls(parsed, schema));
  } catch {
    return text;
  }
};

const contract = (name: string, schema: z.ZodType): ResponseContract => ({
  name,
  version: 1,
  schema: z.toJSONSchema(schema, { target: "draft-7" }) as Record<
    string,
    unknown
  >,
});

export const MemoryPatchContract = contract(
  "MemoryPatch",
  WriterMemoryPatchSchema,
);
export const SemanticComparisonContract = contract(
  "SemanticComparison",
  SemanticComparisonSchema,
);

export const serializeResponseContract = (value: ResponseContract): string =>
  JSON.stringify(value, null, 2);
