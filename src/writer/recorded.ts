import type {
  GenerateRequest,
  GenerateResponse,
  GenerativeProvider,
} from "./provider";

export type RecordedModelResponse =
  | { response: GenerateResponse; delayMs?: number }
  | { error: Error; delayMs?: number };

const abortableDelay = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("recorded call aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    if (signal?.aborted === true) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });

export class RecordedProvider implements GenerativeProvider {
  readonly requests: GenerateRequest[] = [];
  readonly #responses: RecordedModelResponse[];

  constructor(
    responses: RecordedModelResponse[],
    readonly id = "recorded",
  ) {
    this.#responses = [...responses];
  }

  async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const { signal: _signal, ...recorded } = request;
    this.requests.push(structuredClone(recorded));
    const next = this.#responses.shift();
    if (next === undefined) throw new Error("recorded response not configured");
    if (next.delayMs !== undefined)
      await abortableDelay(next.delayMs, request.signal);
    if ("error" in next) throw next.error;
    return structuredClone(next.response);
  }
}
