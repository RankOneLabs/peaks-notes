import type {
  CompressInput,
  MemoryPatch,
  UpdateInput,
  Writer,
} from "../schema";
import { MemoryPatchContract } from "../schema";
import { parseMemoryPatch } from "./parse";
import { buildCompressPrompt, buildUpdatePrompt } from "./prompt";
import {
  AdapterError,
  estimateModelTokens,
  type GenerateResponse,
  type GenerativeProvider,
  type ModelAdapterConfig,
  type ModelCall,
} from "./provider";

export class LlmWriter implements Writer {
  #lastCall: ModelCall | undefined;
  #activeCall: { startedAt: number; call: ModelCall } | undefined;
  readonly #callsByResult = new WeakMap<MemoryPatch, ModelCall>();

  constructor(
    readonly provider: GenerativeProvider,
    readonly config: ModelAdapterConfig,
  ) {}

  getLastCall(): ModelCall | undefined {
    return this.#lastCall === undefined
      ? undefined
      : structuredClone(this.#lastCall);
  }

  getCallFor(result: MemoryPatch): ModelCall | undefined {
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

  async #call(prompt: { system: string; user: string }): Promise<MemoryPatch> {
    const startedAt = performance.now();
    const inputTokens = estimateModelTokens(`${prompt.system}\n${prompt.user}`);
    const emptyUsage = {
      inputTokens,
      outputTokens: 0,
      totalTokens: inputTokens,
    };
    const call = (
      usage = emptyUsage,
      dispatched = false,
      usageProvenance: ModelCall["usageProvenance"] = "estimated",
    ): ModelCall => ({
      provider: this.provider.id,
      model: this.config.model,
      promptVersion: this.config.promptVersion,
      usage,
      latencyMs: Math.max(0, performance.now() - startedAt),
      dispatched,
      usageProvenance,
    });
    if (inputTokens > this.config.maxInputTokens) {
      this.#lastCall = call();
      throw new AdapterError(
        "input_too_long",
        `writer input ${inputTokens} tokens exceeds ${this.config.maxInputTokens}`,
        this.#lastCall,
      );
    }
    let response: GenerateResponse;
    this.#activeCall = {
      startedAt,
      call: call(emptyUsage, true, "unknown"),
    };
    try {
      response = await new Promise<
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
            responseContract: MemoryPatchContract,
          })
          .then(resolve, reject)
          .finally(() => clearTimeout(timer));
      });
    } catch (cause) {
      const timedOut =
        cause instanceof DOMException && cause.name === "AbortError";
      this.#lastCall = call(
        emptyUsage,
        true,
        timedOut ? "unknown" : "estimated",
      );
      this.#activeCall = undefined;
      throw new AdapterError(
        timedOut ? "timeout" : "provider_error",
        timedOut
          ? `writer deadline expired after ${Math.round(this.#lastCall.latencyMs)}ms`
          : `writer provider failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        this.#lastCall,
        cause,
      );
    }
    this.#activeCall = undefined;
    const completedCall = {
      ...call(response.usage, true, "reported"),
      model: response.model,
    };
    this.#lastCall = completedCall;
    try {
      const result = parseMemoryPatch(response.text);
      this.#callsByResult.set(result, structuredClone(completedCall));
      return result;
    } catch (cause) {
      throw new AdapterError(
        "invalid_response",
        cause instanceof Error ? cause.message : String(cause),
        this.#lastCall,
        cause,
      );
    }
  }

  propose(input: UpdateInput): Promise<MemoryPatch> {
    return this.#call(buildUpdatePrompt(input));
  }

  compress(input: CompressInput): Promise<MemoryPatch> {
    return this.#call(buildCompressPrompt(input));
  }
}
