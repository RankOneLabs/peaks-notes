import type {
  Evaluator,
  SemanticComparison,
  SemanticComparisonInput,
} from "../schema";
import type { StubResponse } from "../replay/fixture";

export class StubEvaluator implements Evaluator {
  readonly calls: SemanticComparisonInput[] = [];
  readonly #outputs: StubResponse<SemanticComparison>[];

  constructor(outputs: StubResponse<SemanticComparison>[] = []) {
    this.#outputs = [...outputs];
  }

  async compare(input: SemanticComparisonInput): Promise<SemanticComparison> {
    this.calls.push(structuredClone(input));
    const response = this.#outputs.shift();
    if (response === undefined) throw new Error("stub response not configured");
    if (response.delayMs !== undefined) {
      await new Promise((done) => setTimeout(done, response.delayMs));
    }
    if (response.error !== undefined) throw new Error(response.error);
    if (response.output === undefined) throw new Error("stub response has no output");
    return structuredClone(response.output);
  }
}
