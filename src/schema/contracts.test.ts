import { expect, test } from "bun:test";
import {
  anthropicResponseSchema,
  normalizeOpenAIStrictResponse,
  openAIStrictResponseSchema,
} from "./contracts";

const schema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  properties: {
    name: { type: "string", minLength: 1 },
    kind: { type: "string", enum: ["a", "b"] },
    items: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          start: { type: "integer", minimum: 0 },
        },
        required: ["id"],
      },
    },
  },
  required: ["name", "items"],
};

test("OpenAI strict schemas require every property and make optionals nullable", () => {
  expect(openAIStrictResponseSchema(schema)).toEqual({
    type: "object",
    properties: {
      name: { type: "string" },
      kind: { type: ["string", "null"], enum: ["a", "b", null] },
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            start: { type: ["integer", "null"] },
          },
          required: ["id", "start"],
          additionalProperties: false,
        },
      },
    },
    required: ["name", "kind", "items"],
    additionalProperties: false,
  });
  expect(schema.properties.name).toHaveProperty("minLength");
});

test("Anthropic schemas drop unsupported keywords but keep optionals", () => {
  const transformed = anthropicResponseSchema(schema);
  expect(transformed).not.toHaveProperty("$schema");
  expect(transformed).toMatchObject({
    required: ["name", "items"],
    properties: {
      name: { type: "string" },
      items: { items: { required: ["id"] } },
    },
  });
  expect(JSON.stringify(transformed)).not.toMatch(/minLength|maxItems|minimum/);
});

test("normalizing a strict response removes only optional nulls", () => {
  const text = JSON.stringify({
    name: "n",
    kind: null,
    items: [
      { id: "x", start: null },
      { id: "y", start: 2 },
    ],
  });
  expect(JSON.parse(normalizeOpenAIStrictResponse(text, schema))).toEqual({
    name: "n",
    items: [{ id: "x" }, { id: "y", start: 2 }],
  });
  expect(normalizeOpenAIStrictResponse("not json", schema)).toBe("not json");
});
