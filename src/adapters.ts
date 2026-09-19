import { JevClient } from "./classifier/jev/client";
import { JevClassifier } from "./classifier/jev/jev_classifier";
import type { AppConfig } from "./config";
import { LlmEvaluator } from "./evaluator/llm_evaluator";
import { LlmWriter } from "./writer/llm_writer";
import { createProvider } from "./writer/provider";

/** Construct the three live adapter roles from one startup-validated config. */
export const createConfiguredAdapters = (
  config: AppConfig,
  fetchImplementation: typeof fetch = fetch,
): {
  writer: LlmWriter;
  evaluator: LlmEvaluator;
  classifier: JevClassifier;
} => ({
  writer: new LlmWriter(
    createProvider(config.writer, fetchImplementation),
    config.writer,
  ),
  evaluator: new LlmEvaluator(
    createProvider(config.evaluator, fetchImplementation),
    config.evaluator,
  ),
  classifier: new JevClassifier(
    new JevClient({
      bearerKey: config.jev.bearerKey,
      endpoint: config.jev.endpoint,
      deadlineMs: config.jev.deadlineMs,
      fetch: fetchImplementation,
    }),
    {
      maxInputTokens: config.jev.maxInputTokens,
      contextTokens: config.jev.contextTokens,
    },
  ),
});
