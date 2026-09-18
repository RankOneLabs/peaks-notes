import type {
  Assessment,
  Classifier,
  RelevanceInput,
  RelevanceResult,
  RelationshipInput,
} from "../schema";
import type { StubResponse } from "../replay/fixture";

const resolve = async <T>(response: StubResponse<T> | undefined): Promise<T> => {
  if (response === undefined) throw new Error("stub response not configured");
  if (response.delayMs !== undefined) {
    await new Promise((done) => setTimeout(done, response.delayMs));
  }
  if (response.error !== undefined) throw new Error(response.error);
  if (response.output === undefined) throw new Error("stub response has no output");
  return structuredClone(response.output);
};

export type ClassifierStubOutputs = {
  relevance?: StubResponse<RelevanceResult>[];
  assessments?: StubResponse<Assessment>[];
};

export class StubClassifier implements Classifier {
  readonly relevanceCalls: RelevanceInput[] = [];
  readonly relationshipCalls: RelationshipInput[] = [];
  readonly #relevance: StubResponse<RelevanceResult>[];
  readonly #assessments: StubResponse<Assessment>[];

  constructor(outputs: ClassifierStubOutputs = {}) {
    this.#relevance = [...(outputs.relevance ?? [])];
    this.#assessments = [...(outputs.assessments ?? [])];
  }

  async scoreRelevance(input: RelevanceInput): Promise<RelevanceResult> {
    this.relevanceCalls.push(structuredClone(input));
    return resolve(this.#relevance.shift());
  }

  async classifyRelationships(input: RelationshipInput): Promise<Assessment> {
    this.relationshipCalls.push(structuredClone(input));
    return resolve(this.#assessments.shift());
  }
}
