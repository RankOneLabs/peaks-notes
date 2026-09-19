import { expect, test } from "bun:test";
import { JevClient, JevClientError } from "./client";
import { JevClassifier } from "./jev_classifier";
import { recordedJevFetch } from "./recorded";
import { JEV_MODEL, type JevRequest } from "./wire";

const request: JevRequest = {
  model: JEV_MODEL,
  state: "state",
  questions: { topic: { type: "noul", instructions: "related?" } },
};
const success = {
  model: JEV_MODEL,
  answers: { topic: { type: "noul", noul: 0.9 } },
  usage: { input_tokens: 100, output_tokens: 10 },
};

test("429 followed by 200 retries with bearer authorization", async () => {
  const recorded = recordedJevFetch([
    { status: 429 },
    { status: 200, body: success },
  ]);
  const client = new JevClient({
    bearerKey: "secret",
    deadlineMs: 1000,
    fetch: recorded.fetch,
    sleep: async () => {},
  });
  const result = await client.call(request);
  expect(result.response.answers.topic).toMatchObject({ noul: 0.9 });
  expect(result.usage.costUsd).toBeCloseTo(0.0000042);
  expect(recorded.requests).toHaveLength(2);
  expect(
    new Headers(recorded.requests[0]?.init?.headers).get("Authorization"),
  ).toBe("Bearer secret");
});

test("repeated throttling past deadline is a typed timeout with usage", async () => {
  const recorded = recordedJevFetch(
    Array.from({ length: 10 }, () => ({ status: 529 })),
  );
  let now = 0;
  const client = new JevClient({
    bearerKey: "secret",
    deadlineMs: 250,
    fetch: recorded.fetch,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  try {
    await client.call(request);
    throw new Error("expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(JevClientError);
    expect((error as JevClientError).code).toBe("timeout");
    expect((error as JevClientError).usage.latencyMs).toBe(250);
  }
});

test("deadline remains active while consuming a Jev response body", async () => {
  const client = new JevClient({
    bearerKey: "secret",
    deadlineMs: 2,
    fetch: (async (_input, init) => ({
      status: 200,
      ok: true,
      json: () =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("deadline expired", "AbortError")),
          );
        }),
    })) as typeof fetch,
  });
  try {
    await client.call(request);
    throw new Error("expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(JevClientError);
    expect((error as JevClientError).code).toBe("timeout");
  }
});

test("getCalls returns every recorded trace without draining", async () => {
  const recorded = recordedJevFetch([
    { status: 200, body: success },
    { status: 200, body: success },
  ]);
  const classifier = new JevClassifier(
    new JevClient({
      bearerKey: "secret",
      deadlineMs: 100,
      fetch: recorded.fetch,
    }),
  );
  const input = {
    chunk: {
      id: "chunk-1" as never,
      createdAt: "2026-09-18T00:00:00.000Z",
      messages: [
        { id: "message-1" as never, role: "user" as const, content: "hi" },
      ],
    },
    taskContext: { currentTask: "test", compactionInstructions: [] },
    topics: [{ id: "topic" as never, title: "Topic", description: "routing" }],
  };
  await classifier.scoreRelevance(input);
  await classifier.scoreRelevance(input);
  expect(classifier.getCalls()).toHaveLength(2);
  expect(classifier.getCalls()).toHaveLength(2);
  expect(classifier.drainCalls()).toHaveLength(2);
});
