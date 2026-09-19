import type {
  GenerateRequest,
  GenerateResponse,
  GenerativeProvider,
} from "./provider";

export type RecordedModelResponse =
  | { response: GenerateResponse; delayMs?: number }
  | { error: Error; delayMs?: number };

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
    this.requests.push(structuredClone(request));
    const next = this.#responses.shift();
    if (next === undefined) throw new Error("recorded response not configured");
    if (next.delayMs !== undefined)
      await new Promise((resolve) => setTimeout(resolve, next.delayMs));
    if ("error" in next) throw next.error;
    return structuredClone(next.response);
  }
}
