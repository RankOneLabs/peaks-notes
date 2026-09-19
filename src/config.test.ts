import { expect, test } from "bun:test";
import { createConfiguredAdapters } from "./adapters";
import { loadConfig } from "./config";

const valid = {
  WRITER_PROVIDER: "openai",
  OPENAI_API_KEY: "writer-secret",
  WRITER_MODEL: "writer-model",
  JEV_BEARER_KEY: "jev-secret",
};

test("loads typed defaults and pins Jev", () => {
  const config = loadConfig(valid);
  expect(config.jev.model).toBe("jev-1.13.0");
  expect(config.writer.promptVersion).toBe("writer-v1");
  expect(config.evaluator.apiKey).toBe("writer-secret");
});

test("missing provider key fails startup and names the field", () => {
  expect(() => loadConfig({ ...valid, OPENAI_API_KEY: undefined })).toThrow(
    expect.objectContaining({
      code: "configuration_error",
      field: "OPENAI_API_KEY",
    }),
  );
});

test("Jev aliases are rejected", () => {
  expect(() => loadConfig({ ...valid, JEV_MODEL: "jev-latest" })).toThrow(
    expect.objectContaining({ field: "jev.model" }),
  );
});

test("different evaluator providers require an evaluator model", () => {
  expect(() =>
    loadConfig({
      ...valid,
      EVALUATOR_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "evaluator-secret",
    }),
  ).toThrow(
    expect.objectContaining({
      code: "configuration_error",
      field: "EVALUATOR_MODEL",
    }),
  );
});

test("configured prompt versions must name implemented templates", () => {
  expect(() =>
    loadConfig({ ...valid, EVALUATOR_PROMPT_VERSION: "future-v2" }),
  ).toThrow(
    expect.objectContaining({
      code: "configuration_error",
      field: "EVALUATOR_PROMPT_VERSION",
    }),
  );
});

test("validated configuration constructs all live adapter roles", () => {
  const adapters = createConfiguredAdapters(loadConfig(valid));
  expect(adapters.writer.constructor.name).toBe("LlmWriter");
  expect(adapters.evaluator.constructor.name).toBe("LlmEvaluator");
  expect(adapters.classifier.constructor.name).toBe("JevClassifier");
});
