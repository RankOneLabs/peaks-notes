import {
  type CallOptions,
  type Evaluator,
  type SemanticComparison,
  SemanticComparisonContract,
  type SemanticComparisonInput,
} from "../schema";
import {
  AdapterError,
  estimateModelTokens,
  type GenerativeProvider,
  generateWithin,
  type ModelAdapterConfig,
  type ModelCall,
} from "../writer/provider";
import { parseSemanticComparison } from "./parse";
import { buildEvaluatorPrompt, EVALUATOR_PROMPT_VERSION } from "./prompt";
import { memorySemanticallyEqual } from "./snapshot_diff";

export class LlmEvaluator implements Evaluator {
  #lastCall: ModelCall | undefined;
  #activeCall: { startedAt: number; call: ModelCall } | undefined;
  readonly #callsByResult = new WeakMap<SemanticComparison, ModelCall>();
  constructor(
    readonly provider: GenerativeProvider,
    readonly config: ModelAdapterConfig,
  ) {}

  getLastCall(): ModelCall | undefined {
    return this.#lastCall === undefined
      ? undefined
      : structuredClone(this.#lastCall);
  }

  getCallFor(result: SemanticComparison): ModelCall | undefined {
    const call = this.#callsByResult.get(result);
    return call === undefined ? undefined : structuredClone(call);
  }

  getActiveCall(): ModelCall | undefined {
    return this.#activeCall === undefined
      ? undefined
      : {
          ...structuredClone(this.#activeCall.call),
          latencyMs: Math.max(
            0,
            performance.now() - this.#activeCall.startedAt,
          ),
        };
  }

  #record(result: SemanticComparison, call: ModelCall): SemanticComparison {
    this.#lastCall = call;
    this.#callsByResult.set(result, structuredClone(call));
    return result;
  }

  async compare(
    input: SemanticComparisonInput,
    options?: CallOptions,
  ): Promise<SemanticComparison> {
    const signal = options?.signal;
    if (memorySemanticallyEqual(input.before, input.after)) {
      const result: SemanticComparison = {
        verdict: "equivalent",
        changes: [],
      };
      return this.#record(result, {
        provider: this.provider.id,
        model: this.config.model,
        promptVersion: EVALUATOR_PROMPT_VERSION,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        latencyMs: 0,
        dispatched: false,
        usageProvenance: "estimated",
      });
    }
    const prompt = buildEvaluatorPrompt(input);
    const startedAt = performance.now();
    const inputTokens = estimateModelTokens(`${prompt.system}\n${prompt.user}`);
    const call = (
      outputTokens = 0,
      dispatched = false,
      usageProvenance: ModelCall["usageProvenance"] = "estimated",
    ): ModelCall => ({
      provider: this.provider.id,
      model: this.config.model,
      promptVersion: EVALUATOR_PROMPT_VERSION,
      usage: {
        inputTokens,
        outputTokens,
        totalTokens: inputTokens + outputTokens,
      },
      latencyMs: Math.max(0, performance.now() - startedAt),
      dispatched,
      usageProvenance,
    });
    if (inputTokens > this.config.maxInputTokens) {
      this.#lastCall = call();
      throw new AdapterError(
        "input_too_long",
        "evaluator input exceeds token limit",
        this.#lastCall,
      );
    }
    const active = { startedAt, call: call(0, true, "unknown") };
    try {
      this.#activeCall = active;
      const response = await generateWithin(this.provider, {
        ...prompt,
        model: this.config.model,
        promptVersion: EVALUATOR_PROMPT_VERSION,
        deadlineMs: this.config.deadlineMs,
        responseContract: SemanticComparisonContract,
        ...(signal === undefined ? {} : { signal }),
      });
      const completedCall: ModelCall = {
        provider: this.provider.id,
        model: response.model,
        promptVersion: EVALUATOR_PROMPT_VERSION,
        usage: response.usage,
        latencyMs: Math.max(0, performance.now() - startedAt),
        dispatched: true,
        usageProvenance: "reported",
      };
      if (this.#activeCall === active) this.#activeCall = undefined;
      try {
        const result = parseSemanticComparison(response.text);
        return this.#record(result, completedCall);
      } catch (cause) {
        this.#lastCall = completedCall;
        throw new AdapterError(
          "invalid_response",
          cause instanceof Error ? cause.message : String(cause),
          completedCall,
          cause,
        );
      }
    } catch (cause) {
      if (this.#activeCall === active) this.#activeCall = undefined;
      if (cause instanceof AdapterError) throw cause;
      const timedOut =
        cause instanceof DOMException && cause.name === "AbortError";
      const failedCall = call(0, true, timedOut ? "unknown" : "estimated");
      // A cancelled call may settle during a later call; leave that call's state alone.
      if (signal?.aborted !== true) this.#lastCall = failedCall;
      throw new AdapterError(
        timedOut ? "timeout" : "provider_error",
        timedOut ? "evaluator deadline expired" : "evaluator provider failed",
        failedCall,
        cause,
      );
    }
  }
}
