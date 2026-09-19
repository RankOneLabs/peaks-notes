import { z } from "zod";
import type { JevRequest, JevResponse } from "./wire";
import { parseJevResponse } from "./wire";

export const JEV_INPUT_COST_PER_MILLION_TOKENS_USD = 0.15;

export type JevUsage = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
};

export class JevClientError extends Error {
  constructor(
    readonly code: "timeout" | "http_error" | "invalid_response",
    message: string,
    readonly usage: JevUsage,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "JevClientError";
  }
}

export type JevClientOptions = {
  bearerKey: string;
  deadlineMs: number;
  endpoint?: string;
  fetch?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
};

const emptyUsage = (latencyMs: number): JevUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  costUsd: 0,
  latencyMs,
});

export class JevClient {
  readonly #fetch: typeof fetch;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #now: () => number;

  constructor(readonly options: JevClientOptions) {
    this.#fetch = options.fetch ?? fetch;
    this.#sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#now = options.now ?? (() => performance.now());
  }

  async call(
    request: JevRequest,
  ): Promise<{ response: JevResponse; usage: JevUsage }> {
    const startedAt = this.#now();
    let delayMs = 100;
    for (;;) {
      const elapsed = this.#now() - startedAt;
      const remaining = this.options.deadlineMs - elapsed;
      if (remaining <= 0) {
        throw new JevClientError(
          "timeout",
          `Jev deadline expired after ${Math.max(0, elapsed)}ms`,
          emptyUsage(Math.max(0, elapsed)),
        );
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);
      let response: Response;
      try {
        response = await this.#fetch(
          this.options.endpoint ?? "https://api.typesafe.ai/v1/systemone",
          {
            method: "POST",
            signal: controller.signal,
            headers: {
              Authorization: `Bearer ${this.options.bearerKey}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(request),
          },
        );
      } catch (cause) {
        clearTimeout(timer);
        const nowElapsed = Math.max(0, this.#now() - startedAt);
        const timedOut =
          cause instanceof DOMException && cause.name === "AbortError";
        throw new JevClientError(
          timedOut ? "timeout" : "http_error",
          timedOut
            ? `Jev deadline expired after ${nowElapsed}ms`
            : "Jev request failed",
          emptyUsage(nowElapsed),
          cause,
        );
      }
      clearTimeout(timer);
      if (response.status === 429 || response.status === 529) {
        const wait = Math.min(
          delayMs,
          this.options.deadlineMs - (this.#now() - startedAt),
        );
        if (wait <= 0) continue;
        await this.#sleep(wait);
        delayMs *= 2;
        continue;
      }
      const latencyMs = Math.max(0, this.#now() - startedAt);
      if (!response.ok) {
        throw new JevClientError(
          "http_error",
          `Jev HTTP ${response.status}`,
          emptyUsage(latencyMs),
        );
      }
      let raw: unknown;
      try {
        raw = await response.json();
        const parsed = parseJevResponse(raw, request);
        const inputTokens = parsed.usage.input_tokens;
        const outputTokens = parsed.usage.output_tokens;
        return {
          response: parsed,
          usage: {
            inputTokens,
            outputTokens,
            costUsd:
              (inputTokens / 1_000_000) * JEV_INPUT_COST_PER_MILLION_TOKENS_USD,
            latencyMs,
          },
        };
      } catch (cause) {
        throw new JevClientError(
          "invalid_response",
          cause instanceof z.ZodError
            ? `invalid Jev response: ${cause.issues.map((issue) => issue.message).join("; ")}`
            : `invalid Jev response: ${cause instanceof Error ? cause.message : String(cause)}`,
          emptyUsage(latencyMs),
          cause,
        );
      }
    }
  }
}
