import { z } from "zod";
import type { ModelAdapterConfig } from "../config";

export type { ModelAdapterConfig } from "../config";

export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
};

export type ModelCall = {
  provider: string;
  model: string;
  promptVersion: string;
  usage: ModelUsage;
  latencyMs: number;
};

export type GenerateRequest = {
  system: string;
  user: string;
  model: string;
  promptVersion: string;
  deadlineMs: number;
  responseSchemaName: string;
};

export type GenerateResponse = {
  text: string;
  usage: ModelUsage;
  model: string;
};

export interface GenerativeProvider {
  readonly id: string;
  generate(request: GenerateRequest): Promise<GenerateResponse>;
}

export type AdapterErrorCode =
  | "invalid_response"
  | "timeout"
  | "input_too_long"
  | "provider_error";

export class AdapterError extends Error {
  constructor(
    readonly code: AdapterErrorCode,
    message: string,
    readonly usage: ModelCall,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AdapterError";
  }
}

const usage = (inputTokens = 0, outputTokens = 0): ModelUsage => ({
  inputTokens,
  outputTokens,
  totalTokens: inputTokens + outputTokens,
});

const readJson = async (response: Response): Promise<unknown> => {
  try {
    return await response.json();
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "AbortError")
      throw cause;
    throw new Error("provider returned non-JSON response", { cause });
  }
};

const OpenAIResponseSchema = z
  .object({
    model: z.string().min(1).optional(),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative(),
      })
      .passthrough(),
    output: z.array(
      z
        .object({
          content: z.array(
            z.object({ text: z.string().optional() }).passthrough(),
          ),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const AnthropicResponseSchema = z
  .object({
    model: z.string().min(1).optional(),
    usage: z
      .object({
        input_tokens: z.number().int().nonnegative(),
        output_tokens: z.number().int().nonnegative(),
      })
      .passthrough(),
    content: z.array(z.object({ text: z.string().optional() }).passthrough()),
  })
  .passthrough();

const withAbortDeadline = async <T>(
  deadlineMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
};

export const createProvider = (
  config: ModelAdapterConfig,
  fetchImplementation: typeof fetch = fetch,
): GenerativeProvider => {
  if (config.provider === "openai") {
    return {
      id: "openai",
      async generate(request) {
        const raw = await withAbortDeadline(
          request.deadlineMs,
          async (signal) => {
            const response = await fetchImplementation(
              config.endpoint ?? "https://api.openai.com/v1/responses",
              {
                method: "POST",
                signal,
                headers: {
                  Authorization: `Bearer ${config.apiKey}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  model: request.model,
                  instructions: request.system,
                  input: request.user,
                  store: false,
                  text: { format: { type: "json_object" } },
                }),
              },
            );
            if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}`);
            return readJson(response);
          },
        );
        const body = OpenAIResponseSchema.parse(raw);
        const inputTokens = body.usage.input_tokens;
        const outputTokens = body.usage.output_tokens;
        const text = body.output
          .flatMap((item) => item.content)
          .map((item) => item.text)
          .find((item): item is string => typeof item === "string");
        if (text === undefined)
          throw new Error("OpenAI response omitted output text");
        return {
          text,
          usage: usage(inputTokens, outputTokens),
          model: body.model ?? request.model,
        };
      },
    };
  }
  return {
    id: "anthropic",
    async generate(request) {
      const raw = await withAbortDeadline(
        request.deadlineMs,
        async (signal) => {
          const response = await fetchImplementation(
            config.endpoint ?? "https://api.anthropic.com/v1/messages",
            {
              method: "POST",
              signal,
              headers: {
                "x-api-key": config.apiKey,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                model: request.model,
                max_tokens: 8192,
                system: request.system,
                messages: [{ role: "user", content: request.user }],
              }),
            },
          );
          if (!response.ok)
            throw new Error(`Anthropic HTTP ${response.status}`);
          return readJson(response);
        },
      );
      const body = AnthropicResponseSchema.parse(raw);
      const inputTokens = body.usage.input_tokens;
      const outputTokens = body.usage.output_tokens;
      const text = body.content
        .map((item) => item.text)
        .find((item): item is string => typeof item === "string");
      if (text === undefined)
        throw new Error("Anthropic response omitted output text");
      return {
        text,
        usage: usage(inputTokens, outputTokens),
        model: body.model ?? request.model,
      };
    },
  };
};

/** Conservative estimate used only to reject requests, never to silently truncate them. */
export const estimateModelTokens = (text: string): number =>
  Math.ceil(new TextEncoder().encode(text).byteLength / 3);
