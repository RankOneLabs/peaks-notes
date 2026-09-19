import { z } from "zod";

const PositiveMillisecondsSchema = z.coerce.number().int().positive();

export const GenerativeProviderSchema = z.enum(["openai", "anthropic"]);
export type GenerativeProviderName = z.infer<typeof GenerativeProviderSchema>;

export const ModelAdapterConfigSchema = z
  .object({
    provider: GenerativeProviderSchema,
    apiKey: z.string().min(1),
    model: z.string().min(1),
    endpoint: z.string().url().optional(),
    deadlineMs: PositiveMillisecondsSchema,
    promptVersion: z.string().min(1),
    maxInputTokens: z.number().int().positive().default(32_000),
  })
  .strict();
export type ModelAdapterConfig = z.infer<typeof ModelAdapterConfigSchema>;

export const AppConfigSchema = z
  .object({
    writer: ModelAdapterConfigSchema,
    evaluator: ModelAdapterConfigSchema,
    jev: z
      .object({
        bearerKey: z.string().min(1),
        model: z.literal("jev-1.13.0"),
        endpoint: z.string().url(),
        deadlineMs: PositiveMillisecondsSchema,
        maxInputTokens: z.number().int().positive(),
        contextTokens: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();
export type AppConfig = z.infer<typeof AppConfigSchema>;

export class ConfigurationError extends Error {
  readonly code = "configuration_error" as const;
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
    this.name = "ConfigurationError";
  }
}

const required = (
  environment: Record<string, string | undefined>,
  field: string,
): string => {
  const value = environment[field];
  if (value === undefined || value.trim() === "") {
    throw new ConfigurationError(`missing required configuration: ${field}`, field);
  }
  return value;
};

const optional = (
  environment: Record<string, string | undefined>,
  field: string,
  fallback: string,
): string => environment[field] ?? fallback;

/** Parse all model configuration at startup; no credential is ever serialized. */
export const loadConfig = (
  environment: Record<string, string | undefined> = process.env,
): AppConfig => {
  const writerProvider = GenerativeProviderSchema.safeParse(
    optional(environment, "WRITER_PROVIDER", "openai"),
  );
  if (!writerProvider.success) {
    throw new ConfigurationError(
      "invalid configuration: WRITER_PROVIDER",
      "WRITER_PROVIDER",
    );
  }
  const evaluatorProvider = GenerativeProviderSchema.safeParse(
    optional(environment, "EVALUATOR_PROVIDER", writerProvider.data),
  );
  if (!evaluatorProvider.success) {
    throw new ConfigurationError(
      "invalid configuration: EVALUATOR_PROVIDER",
      "EVALUATOR_PROVIDER",
    );
  }

  const writerKeyField = `${writerProvider.data.toUpperCase()}_API_KEY`;
  const evaluatorKeyField = `${evaluatorProvider.data.toUpperCase()}_API_KEY`;
  const raw = {
    writer: {
      provider: writerProvider.data,
      apiKey: required(environment, "WRITER_API_KEY" in environment ? "WRITER_API_KEY" : writerKeyField),
      model: required(environment, "WRITER_MODEL"),
      ...(environment.WRITER_ENDPOINT === undefined
        ? {}
        : { endpoint: environment.WRITER_ENDPOINT }),
      deadlineMs: optional(environment, "WRITER_DEADLINE_MS", "30000"),
      promptVersion: optional(environment, "WRITER_PROMPT_VERSION", "writer-v1"),
      maxInputTokens: Number(optional(environment, "WRITER_MAX_INPUT_TOKENS", "32000")),
    },
    evaluator: {
      provider: evaluatorProvider.data,
      apiKey:
        environment.EVALUATOR_API_KEY ??
        (evaluatorProvider.data === writerProvider.data
          ? required(environment, "WRITER_API_KEY" in environment ? "WRITER_API_KEY" : writerKeyField)
          : required(environment, evaluatorKeyField)),
      model: environment.EVALUATOR_MODEL ?? required(environment, "WRITER_MODEL"),
      ...(environment.EVALUATOR_ENDPOINT === undefined
        ? {}
        : { endpoint: environment.EVALUATOR_ENDPOINT }),
      deadlineMs: optional(environment, "EVALUATOR_DEADLINE_MS", "30000"),
      promptVersion: optional(environment, "EVALUATOR_PROMPT_VERSION", "evaluator-v1"),
      maxInputTokens: Number(optional(environment, "EVALUATOR_MAX_INPUT_TOKENS", "32000")),
    },
    jev: {
      bearerKey: required(environment, "JEV_BEARER_KEY"),
      model: optional(environment, "JEV_MODEL", "jev-1.13.0"),
      endpoint: optional(
        environment,
        "JEV_ENDPOINT",
        "https://api.typesafe.ai/v1/systemone",
      ),
      deadlineMs: optional(environment, "JEV_DEADLINE_MS", "30000"),
      maxInputTokens: Number(optional(environment, "JEV_MAX_INPUT_TOKENS", "32000")),
      contextTokens: Number(optional(environment, "JEV_CONTEXT_TOKENS", "64000")),
    },
  };
  const parsed = AppConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".") || "configuration";
    throw new ConfigurationError(
      `invalid configuration for ${field}: ${issue?.message ?? "unknown error"}`,
      field,
    );
  }
  return parsed.data;
};
