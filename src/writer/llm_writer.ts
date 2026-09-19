import type { CompressInput, MemoryPatch, UpdateInput, Writer } from "../schema";
import {
  AdapterError,
  estimateModelTokens,
  type GenerativeProvider,
  type ModelAdapterConfig,
  type ModelCall,
} from "./provider";
import { buildCompressPrompt, buildUpdatePrompt } from "./prompt";
import { parseMemoryPatch } from "./parse";

export class LlmWriter implements Writer {
  #lastCall: ModelCall | undefined;

  constructor(
    readonly provider: GenerativeProvider,
    readonly config: ModelAdapterConfig,
  ) {}

  getLastCall(): ModelCall | undefined {
    return this.#lastCall === undefined ? undefined : structuredClone(this.#lastCall);
  }

  async #call(prompt: { system: string; user: string }): Promise<MemoryPatch> {
    const startedAt = performance.now();
    const inputTokens = estimateModelTokens(`${prompt.system}\n${prompt.user}`);
    const emptyUsage = {
      inputTokens,
      outputTokens: 0,
      totalTokens: inputTokens,
    };
    const call = (usage = emptyUsage): ModelCall => ({
      provider: this.provider.id,
      model: this.config.model,
      promptVersion: this.config.promptVersion,
      usage,
      latencyMs: Math.max(0, performance.now() - startedAt),
    });
    if (inputTokens > this.config.maxInputTokens) {
      this.#lastCall = call();
      throw new AdapterError(
        "input_too_long",
        `writer input ${inputTokens} tokens exceeds ${this.config.maxInputTokens}`,
        this.#lastCall,
      );
    }
    let response;
    try {
      response = await new Promise<Awaited<ReturnType<GenerativeProvider["generate"]>>>(
        (resolve, reject) => {
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
              responseSchemaName: "MemoryPatch",
            })
            .then(resolve, reject)
            .finally(() => clearTimeout(timer));
        },
      );
    } catch (cause) {
      this.#lastCall = call();
      const timedOut = cause instanceof DOMException && cause.name === "AbortError";
      throw new AdapterError(
        timedOut ? "timeout" : "provider_error",
        timedOut
          ? `writer deadline expired after ${Math.round(this.#lastCall.latencyMs)}ms`
          : `writer provider failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        this.#lastCall,
        cause,
      );
    }
    this.#lastCall = call(response.usage);
    try {
      return parseMemoryPatch(response.text);
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
