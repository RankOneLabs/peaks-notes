import type {
  Assessment,
  Classifier,
  RelationshipInput,
  RelevanceInput,
  RelevanceResult,
} from "../../schema";
import { batchJevQuestions } from "./batch";
import type { JevClient, JevUsage } from "./client";
import {
  type AnswerTrace,
  normalizeRelationships,
  normalizeRelevance,
} from "./normalize";
import { relationshipQuestions, relevanceQuestions } from "./questions";
import type { JevRequest, JevResponse } from "./wire";
import { JEV_MODEL } from "./wire";

export type JevCallTrace = {
  model: typeof JEV_MODEL;
  requests: JevRequest[];
  answers: AnswerTrace[];
  usage: JevUsage;
};

export class JevClassifier implements Classifier {
  #lastCall: JevCallTrace | undefined;
  readonly calls: JevCallTrace[] = [];
  constructor(
    readonly client: JevClient,
    readonly limits = { maxInputTokens: 32_000, contextTokens: 64_000 },
  ) {}

  getLastCall(): JevCallTrace | undefined {
    return this.#lastCall === undefined
      ? undefined
      : structuredClone(this.#lastCall);
  }

  getCalls(): JevCallTrace[] {
    return structuredClone(this.calls);
  }

  #record(trace: JevCallTrace): void {
    this.#lastCall = trace;
    this.calls.push(structuredClone(trace));
  }

  async #run(
    requests: JevRequest[],
  ): Promise<{ responses: JevResponse[]; usage: JevUsage }> {
    const responses: JevResponse[] = [];
    const usage: JevUsage = {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      latencyMs: 0,
    };
    for (const request of requests) {
      const result = await this.client.call(request);
      responses.push(result.response);
      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      usage.costUsd += result.usage.costUsd;
      usage.latencyMs += result.usage.latencyMs;
    }
    return { responses, usage };
  }

  async scoreRelevance(input: RelevanceInput): Promise<RelevanceResult> {
    const built = relevanceQuestions(input);
    const requests = batchJevQuestions(
      built.state,
      built.questions,
      this.limits.maxInputTokens,
      this.limits.contextTokens,
    );
    const { responses, usage } = await this.#run(requests);
    const normalized = normalizeRelevance(requests, responses);
    this.#record({
      model: JEV_MODEL,
      requests,
      answers: normalized.trace,
      usage,
    });
    return normalized.result;
  }

  async classifyRelationships(input: RelationshipInput): Promise<Assessment> {
    const built = relationshipQuestions(input);
    const requests = batchJevQuestions(
      built.state,
      built.questions,
      this.limits.maxInputTokens,
      this.limits.contextTokens,
    );
    const { responses, usage } = await this.#run(requests);
    const normalized = normalizeRelationships(requests, responses);
    this.#record({
      model: JEV_MODEL,
      requests,
      answers: normalized.trace,
      usage,
    });
    return normalized.result;
  }
}
