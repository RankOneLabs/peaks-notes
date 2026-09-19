import type {
  Assessment,
  Classifier,
  RelationshipInput,
  RelevanceInput,
  RelevanceResult,
} from "../../schema";
import { batchJevQuestions } from "./batch";
import { type JevClient, JevClientError, type JevUsage } from "./client";
import {
  type AnswerTrace,
  normalizeRelationships,
  normalizeRelevance,
} from "./normalize";
import {
  RELATIONSHIP_TEMPLATE_VERSION,
  RELEVANCE_TEMPLATE_VERSION,
  relationshipQuestions,
  relevanceQuestions,
} from "./questions";
import type { JevRequest, JevResponse } from "./wire";
import { JEV_MODEL } from "./wire";

export const JEV_PROVIDER = "typesafe";

export type JevCallTrace = {
  operation: "relevance" | "relationships";
  provider: typeof JEV_PROVIDER;
  model: typeof JEV_MODEL;
  promptVersion: string;
  requests: JevRequest[];
  answers: AnswerTrace[];
  usage: JevUsage;
  requestUsage: JevUsage[];
  requestStatuses?: Array<"succeeded" | "failed" | "timed_out">;
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

  drainCalls(): JevCallTrace[] {
    const calls = structuredClone(this.calls);
    this.calls.length = 0;
    return calls;
  }

  #record(call: Omit<JevCallTrace, "provider" | "promptVersion">): void {
    const trace: JevCallTrace = {
      ...call,
      provider: JEV_PROVIDER,
      promptVersion:
        call.operation === "relationships"
          ? RELATIONSHIP_TEMPLATE_VERSION
          : RELEVANCE_TEMPLATE_VERSION,
    };
    this.#lastCall = trace;
    this.calls.push(structuredClone(trace));
  }

  async #run(
    operation: JevCallTrace["operation"],
    requests: JevRequest[],
  ): Promise<{
    responses: JevResponse[];
    usage: JevUsage;
    requestUsage: JevUsage[];
  }> {
    const responses: JevResponse[] = [];
    const usage: JevUsage = {
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      latencyMs: 0,
    };
    const requestUsage: JevUsage[] = [];
    for (const request of requests) {
      let result: Awaited<ReturnType<JevClient["call"]>>;
      try {
        result = await this.client.call(request);
      } catch (cause) {
        const failedUsage =
          cause instanceof JevClientError
            ? cause.usage
            : { inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: 0 };
        requestUsage.push(structuredClone(failedUsage));
        this.#record({
          operation,
          model: JEV_MODEL,
          requests: requests.slice(0, requestUsage.length),
          answers: [],
          usage: {
            inputTokens: usage.inputTokens + failedUsage.inputTokens,
            outputTokens: usage.outputTokens + failedUsage.outputTokens,
            costUsd: usage.costUsd + failedUsage.costUsd,
            latencyMs: usage.latencyMs + failedUsage.latencyMs,
          },
          requestUsage,
          requestStatuses: [
            ...requestUsage.slice(0, -1).map(() => "succeeded" as const),
            cause instanceof JevClientError && cause.code === "timeout"
              ? "timed_out"
              : "failed",
          ],
        });
        throw cause;
      }
      responses.push(result.response);
      requestUsage.push(structuredClone(result.usage));
      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      usage.costUsd += result.usage.costUsd;
      usage.latencyMs += result.usage.latencyMs;
    }
    return { responses, usage, requestUsage };
  }

  async scoreRelevance(input: RelevanceInput): Promise<RelevanceResult> {
    const built = relevanceQuestions(input);
    const requests = batchJevQuestions(
      built.state,
      built.questions,
      this.limits.maxInputTokens,
      this.limits.contextTokens,
    );
    const { responses, usage, requestUsage } = await this.#run(
      "relevance",
      requests,
    );
    const normalized = normalizeRelevance(requests, responses);
    this.#record({
      operation: "relevance",
      model: JEV_MODEL,
      requests,
      answers: normalized.trace,
      usage,
      requestUsage,
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
    const { responses, usage, requestUsage } = await this.#run(
      "relationships",
      requests,
    );
    const normalized = normalizeRelationships(requests, responses);
    this.#record({
      operation: "relationships",
      model: JEV_MODEL,
      requests,
      answers: normalized.trace,
      usage,
      requestUsage,
    });
    return normalized.result;
  }
}
