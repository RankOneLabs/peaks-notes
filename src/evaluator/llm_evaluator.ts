import type {
  Evaluator,
  SemanticComparison,
  SemanticComparisonInput,
} from "../schema";
import {
  AdapterError,
  estimateModelTokens,
  type GenerativeProvider,
  type ModelAdapterConfig,
  type ModelCall,
} from "../writer/provider";
import { parseSemanticComparison } from "./parse";
import { buildEvaluatorPrompt } from "./prompt";
import { memorySemanticallyEqual } from "./snapshot_diff";

export class LlmEvaluator implements Evaluator {
  #lastCall: ModelCall | undefined;
  constructor(
    readonly provider: GenerativeProvider,
    readonly config: ModelAdapterConfig,
  ) {}

  getLastCall(): ModelCall | undefined {
    return this.#lastCall === undefined
      ? undefined
      : structuredClone(this.#lastCall);
  }

  async compare(input: SemanticComparisonInput): Promise<SemanticComparison> {
    if (memorySemanticallyEqual(input.before, input.after)) {
      this.#lastCall = {
        provider: this.provider.id,
        model: this.config.model,
        promptVersion: this.config.promptVersion,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        latencyMs: 0,
      };
      return { verdict: "equivalent", changes: [] };
    }
    const prompt = buildEvaluatorPrompt(input);
    const startedAt = performance.now();
    const inputTokens = estimateModelTokens(`${prompt.system}\n${prompt.user}`);
    const call = (outputTokens = 0): ModelCall => ({
      provider: this.provider.id,
      model: this.config.model,
      promptVersion: this.config.promptVersion,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
      latencyMs: Math.max(0, performance.now() - startedAt),
    });
    if (inputTokens > this.config.maxInputTokens) {
      this.#lastCall = call();
      throw new AdapterError(
        "input_too_long",
        "evaluator input exceeds token limit",
        this.#lastCall,
      );
    }
    try {
      const response = await new Promise<
        Awaited<ReturnType<GenerativeProvider["generate"]>>
      >((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new DOMException("deadline expired", "AbortError")),
          this.config.deadlineMs,
        );
        this.provider
          .generate({
            ...prompt,
            model: this.config.model,
            promptVersion: this.config.promptVersion,
            deadlineMs: this.config.deadlineMs,
            responseSchemaName: "SemanticComparison",
          })
          .then(resolve, reject)
          .finally(() => clearTimeout(timer));
      });
      this.#lastCall = {
        provider: this.provider.id,
        model: response.model,
        promptVersion: this.config.promptVersion,
        usage: response.usage,
        latencyMs: Math.max(0, performance.now() - startedAt),
      };
      try {
        return parseSemanticComparison(response.text);
      } catch (cause) {
        throw new AdapterError(
          "invalid_response",
          cause instanceof Error ? cause.message : String(cause),
          this.#lastCall,
          cause,
        );
      }
    } catch (cause) {
      if (cause instanceof AdapterError) throw cause;
      this.#lastCall = call();
      const timedOut =
        cause instanceof DOMException && cause.name === "AbortError";
      throw new AdapterError(
        timedOut ? "timeout" : "provider_error",
        timedOut ? "evaluator deadline expired" : "evaluator provider failed",
        this.#lastCall,
        cause,
      );
    }
  }
}
