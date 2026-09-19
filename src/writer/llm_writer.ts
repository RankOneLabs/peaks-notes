import type {
  CallOptions,
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
  generateWithin,
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

  async #call(
    prompt: { system: string; user: string },
    signal?: AbortSignal,
  ): Promise<MemoryPatch> {
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
    const active = { startedAt, call: call(emptyUsage, true, "unknown") };
    this.#activeCall = active;
    try {
      response = await generateWithin(this.provider, {
        ...prompt,
        model: this.config.model,
        promptVersion: this.config.promptVersion,
        deadlineMs: this.config.deadlineMs,
        responseContract: MemoryPatchContract,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (cause) {
      const timedOut =
        cause instanceof DOMException && cause.name === "AbortError";
      const failedCall = call(
        emptyUsage,
        true,
        timedOut ? "unknown" : "estimated",
      );
      // A cancelled call may settle during a later call; leave that call's state alone.
      if (signal?.aborted !== true) this.#lastCall = failedCall;
      if (this.#activeCall === active) this.#activeCall = undefined;
      throw new AdapterError(
        timedOut ? "timeout" : "provider_error",
        timedOut
          ? `writer deadline expired after ${Math.round(failedCall.latencyMs)}ms`
          : `writer provider failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        failedCall,
        cause,
      );
    }
    if (this.#activeCall === active) this.#activeCall = undefined;
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

  propose(input: UpdateInput, options?: CallOptions): Promise<MemoryPatch> {
    return this.#call(buildUpdatePrompt(input), options?.signal);
  }

  compress(input: CompressInput, options?: CallOptions): Promise<MemoryPatch> {
    return this.#call(buildCompressPrompt(input), options?.signal);
  }
}
