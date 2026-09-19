import { z } from "zod";
import type { ModelAdapterConfig } from "../config";
import {
  anthropicResponseSchema,
  normalizeOpenAIStrictResponse,
  openAIStrictResponseSchema,
  type ResponseContract,
} from "../schema";

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
  dispatched?: boolean;
  usageProvenance?: "reported" | "estimated" | "unknown";
};

export type GenerateRequest = {
  system: string;
  user: string;
  model: string;
  promptVersion: string;
  deadlineMs: number;
  /** Caller cancellation; the provider aborts on this or its own deadline. */
  signal?: AbortSignal;
  responseContract?: ResponseContract;
  /** @deprecated Use responseContract. */
  responseSchemaName?: string;
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
  { deadlineMs, signal }: GenerateRequest,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> => {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, deadlineMs);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
};

/** Rejects with AbortError once the request deadline or the caller's signal fires. */
export const generateWithin = (
  provider: GenerativeProvider,
  request: GenerateRequest,
): Promise<GenerateResponse> =>
  new Promise((resolve, reject) => {
    const expire = () =>
      reject(new DOMException("deadline expired", "AbortError"));
    if (request.signal?.aborted) {
      expire();
      return;
    }
    const timer = setTimeout(expire, request.deadlineMs);
    request.signal?.addEventListener("abort", expire, { once: true });
    provider
      .generate(request)
      .then(resolve, reject)
      .finally(() => {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", expire);
      });
  });

export const createProvider = (
  config: ModelAdapterConfig,
  fetchImplementation: typeof fetch = fetch,
): GenerativeProvider => {
  if (config.provider === "openai") {
    return {
      id: "openai",
      async generate(request) {
        const raw = await withAbortDeadline(request, async (signal) => {
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
                text:
                  request.responseContract === undefined
                    ? { format: { type: "json_object" } }
                    : {
                        format: {
                          type: "json_schema",
                          name: request.responseContract.name,
                          strict: true,
                          schema: openAIStrictResponseSchema(
                            request.responseContract.schema,
                          ),
                        },
                      },
              }),
            },
          );
          if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}`);
          return readJson(response);
        });
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
          text:
            request.responseContract === undefined
              ? text
              : normalizeOpenAIStrictResponse(
                  text,
                  request.responseContract.schema,
                ),
          usage: usage(inputTokens, outputTokens),
          model: body.model ?? request.model,
        };
      },
    };
  }
  return {
    id: "anthropic",
    async generate(request) {
      const raw = await withAbortDeadline(request, async (signal) => {
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
              ...(request.responseContract === undefined
                ? {}
                : {
                    output_config: {
                      format: {
                        type: "json_schema",
                        schema: anthropicResponseSchema(
                          request.responseContract.schema,
                        ),
                      },
                    },
                  }),
            }),
          },
        );
        if (!response.ok) throw new Error(`Anthropic HTTP ${response.status}`);
        return readJson(response);
      });
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
