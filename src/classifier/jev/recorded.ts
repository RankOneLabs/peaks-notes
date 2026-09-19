import type { JevClientOptions } from "./client";

export type RecordedHttpResponse = {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
};

export const recordedJevFetch = (
  responses: RecordedHttpResponse[],
): {
  fetch: typeof fetch;
  requests: Array<{ url: string; init?: RequestInit }>;
} => {
  const queue = [...responses];
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const recorded = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    requests.push(
      init === undefined
        ? { url: String(input) }
        : {
            url: String(input),
            init: {
              ...(init.method === undefined ? {} : { method: init.method }),
              headers: new Headers(init.headers),
              ...(init.body === undefined || init.body === null
                ? {}
                : { body: init.body }),
            },
          },
    );
    const next = queue.shift();
    if (next === undefined)
      throw new Error("recorded Jev response not configured");
    return new Response(
      next.body === undefined ? undefined : JSON.stringify(next.body),
      {
        status: next.status,
        headers: { "Content-Type": "application/json", ...next.headers },
      },
    );
  }) as typeof fetch;
  return { fetch: recorded, requests };
};

export const recordedClientOptions = (
  responses: RecordedHttpResponse[],
  overrides: Partial<JevClientOptions> = {},
): JevClientOptions & {
  recordedRequests: Array<{ url: string; init?: RequestInit }>;
} => {
  const recorded = recordedJevFetch(responses);
  return {
    bearerKey: "recorded-secret",
    deadlineMs: 1000,
    ...overrides,
    fetch: recorded.fetch,
    recordedRequests: recorded.requests,
  };
};
