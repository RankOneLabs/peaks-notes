import { expect, test } from "bun:test";
import { MemoryPatchContract, type UpdateInput } from "../schema";
import { LlmWriter } from "./llm_writer";
import { parseMemoryPatch } from "./parse";
import { AdapterError, createProvider } from "./provider";
import { RecordedProvider } from "./recorded";

test("parses an exact MemoryPatch JSON object", () => {
  expect(
    parseMemoryPatch(
      JSON.stringify({
        replacements: [],
        newTopics: [],
        addProtected: [],
        supersedeProtected: [],
      }),
    ),
  ).toEqual({
    replacements: [],
    newTopics: [],
    addProtected: [],
    supersedeProtected: [],
  });
});

test("rejects malformed JSON and non-patch output", () => {
  expect(() => parseMemoryPatch("not json")).toThrow("not valid JSON");
  expect(() => parseMemoryPatch("{}")).toThrow("not a MemoryPatch");
});

const input: UpdateInput = {
  chunk: {
    id: "chunk-1" as never,
    createdAt: "2026-09-18T00:00:00.000Z",
    messages: [{ id: "message-1" as never, role: "user", content: "hello" }],
  },
  memory: { revision: 0, topics: [], protected: [], processedChunkIds: [] },
  taskContext: { currentTask: "test", compactionInstructions: [] },
  affectedTopicIds: [],
};

const config = {
  provider: "openai" as const,
  apiKey: "unused",
  model: "recorded-model",
  deadlineMs: 100,
  promptVersion: "writer-test",
  maxInputTokens: 32_000,
};

test("recorded invalid output is a typed invalid_response", async () => {
  const writer = new LlmWriter(
    new RecordedProvider([
      {
        response: {
          text: "not json",
          model: "recorded-model",
          usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
        },
      },
    ]),
    config,
  );
  try {
    await writer.propose(input);
    throw new Error("expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).code).toBe("invalid_response");
    expect((error as AdapterError).usage.usage.totalTokens).toBe(6);
  }
});

test("deadline expiry is typed and includes elapsed usage", async () => {
  const writer = new LlmWriter(
    { id: "never", generate: () => new Promise(() => {}) },
    { ...config, deadlineMs: 2 },
  );
  try {
    await writer.propose(input);
    throw new Error("expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(AdapterError);
    expect((error as AdapterError).code).toBe("timeout");
    expect((error as AdapterError).usage.latencyMs).toBeGreaterThanOrEqual(1);
  }
});

test("OpenAI and Anthropic response bodies are runtime validated", async () => {
  for (const provider of ["openai", "anthropic"] as const) {
    const adapter = createProvider(
      { ...config, provider },
      (async () =>
        new Response(
          JSON.stringify({ usage: "invalid", content: [], output: [] }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        )) as unknown as typeof fetch,
    );
    await expect(
      adapter.generate({
        system: "system",
        user: "user",
        model: "model",
        promptVersion: "test",
        deadlineMs: 100,
        responseSchemaName: "Test",
      }),
    ).rejects.toThrow();
  }
});

test("provider deadline remains active while consuming the response body", async () => {
  for (const provider of ["openai", "anthropic"] as const) {
    let signal: AbortSignal | undefined;
    const adapter = createProvider({ ...config, provider }, (async (
      _input,
      init,
    ) => {
      signal = init?.signal ?? undefined;
      return {
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () =>
              reject(new DOMException("deadline expired", "AbortError")),
            );
          }),
      } as Response;
    }) as typeof fetch);
    await expect(
      adapter.generate({
        system: "system",
        user: "user",
        model: "model",
        promptVersion: "test",
        deadlineMs: 2,
        responseSchemaName: "Test",
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  }
});

test("OpenAI checks status before decoding and disables response storage", async () => {
  let body: Record<string, unknown> | undefined;
  const adapter = createProvider({ ...config, provider: "openai" }, (async (
    _input,
    init,
  ) => {
    body = JSON.parse(String(init?.body));
    return {
      ok: false,
      status: 401,
      json: () => Promise.reject(new Error("must not decode")),
    } as Response;
  }) as typeof fetch);
  await expect(
    adapter.generate({
      system: "system",
      user: "user",
      model: "model",
      promptVersion: "test",
      deadlineMs: 100,
      responseSchemaName: "Test",
    }),
  ).rejects.toThrow("OpenAI HTTP 401");
  expect(body?.store).toBe(false);
});

test("OpenAI sends a strict-compatible schema and restores optional fields", async () => {
  let body: Record<string, unknown> | undefined;
  const adapter = createProvider({ ...config, provider: "openai" }, (async (
    _input,
    init,
  ) => {
    body = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        model: "model",
        usage: { input_tokens: 1, output_tokens: 1 },
        output: [
          {
            content: [
              {
                text: JSON.stringify({
                  replacements: [],
                  newTopics: [],
                  addProtected: [
                    {
                      id: "protected-1",
                      kind: "constraint",
                      text: "Keep this",
                      sources: [
                        { messageId: "message-1", start: null, end: null },
                      ],
                      status: "active",
                      supersededBy: null,
                    },
                  ],
                  supersedeProtected: [],
                }),
              },
            ],
          },
        ],
      }),
    );
  }) as typeof fetch);

  const response = await adapter.generate({
    system: "system",
    user: "user",
    model: "model",
    promptVersion: "test",
    deadlineMs: 100,
    responseContract: MemoryPatchContract,
  });

  expect(body).toMatchObject({
    text: {
      format: {
        strict: true,
        schema: {
          properties: {
            addProtected: {
              items: {
                required: expect.arrayContaining(["supersededBy"]),
                properties: {
                  sources: {
                    items: {
                      required: ["messageId", "start", "end"],
                      properties: { start: { type: ["integer", "null"] } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  expect(parseMemoryPatch(response.text).addProtected[0]).toMatchObject({
    id: "protected-1" as never,
    kind: "constraint",
    text: "Keep this",
    sources: [{ messageId: "message-1" as never }],
    status: "active",
  });
  expect(parseMemoryPatch(response.text).addProtected[0]).not.toHaveProperty(
    "supersededBy",
  );
});

test("Anthropic sends the response contract through output_config", async () => {
  let body: Record<string, unknown> | undefined;
  const adapter = createProvider({ ...config, provider: "anthropic" }, (async (
    _input,
    init,
  ) => {
    body = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        model: "model",
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [
          {
            text: JSON.stringify({
              replacements: [],
              newTopics: [],
              addProtected: [],
              supersedeProtected: [],
            }),
          },
        ],
      }),
    );
  }) as typeof fetch);

  await adapter.generate({
    system: "system",
    user: "user",
    model: "model",
    promptVersion: "test",
    deadlineMs: 100,
    responseContract: MemoryPatchContract,
  });

  expect(body).toMatchObject({
    output_config: {
      format: {
        type: "json_schema",
        schema: { type: "object" },
      },
    },
  });
  expect(JSON.stringify(body)).not.toContain("minLength");
});

test("writer records the provider-resolved model", async () => {
  const provider = new RecordedProvider([
    {
      response: {
        text: JSON.stringify({
          replacements: [],
          newTopics: [],
          addProtected: [],
          supersedeProtected: [],
        }),
        model: "resolved-model-2026-09-18",
        usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
      },
    },
  ]);
  const writer = new LlmWriter(provider, config);
  await writer.propose(input);
  expect(writer.getLastCall()?.model).toBe("resolved-model-2026-09-18");
  expect(provider.requests[0]?.responseContract).toMatchObject({
    name: "MemoryPatch",
    version: 1,
    schema: expect.objectContaining({ type: "object" }),
  });
});
