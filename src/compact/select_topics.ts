import type {
  ClassifierPolicy,
  RelevanceResult,
  Result,
  Topic,
} from "../schema";
import { err, ok } from "../schema";

export type CompactEscalation = {
  code: "escalation";
  gate: "relevance" | "relationship" | "patch";
  message: string;
  policy: CompactEscalationPolicy;
};

export type CompactEscalationPolicy = Partial<
  Pick<
    ClassifierPolicy,
    | "relevanceThreshold"
    | "sameInfoMinConfidence"
    | "uncoveredNoChangeMinConfidence"
  >
>;

export const selectTopics = (
  topics: readonly Topic[],
  response: RelevanceResult,
  policy: ClassifierPolicy,
): Result<Topic[], CompactEscalation> => {
  const known = new Map(topics.map((topic) => [topic.id, topic]));
  const scores = new Map<string, number>();
  for (const item of response.topics) {
    if (!known.has(item.topicId)) {
      return err({
        code: "escalation",
        gate: "relevance",
        message: `unknown topic id: ${item.topicId}`,
        policy: { relevanceThreshold: policy.relevanceThreshold },
      });
    }
    if (!Number.isFinite(item.score)) {
      return err({
        code: "escalation",
        gate: "relevance",
        message: `invalid score for topic: ${item.topicId}`,
        policy: { relevanceThreshold: policy.relevanceThreshold },
      });
    }
    if (scores.has(item.topicId)) {
      return err({
        code: "escalation",
        gate: "relevance",
        message: `duplicate score for topic: ${item.topicId}`,
        policy: { relevanceThreshold: policy.relevanceThreshold },
      });
    }
    scores.set(item.topicId, item.score);
  }
  const missing = topics.find((topic) => !scores.has(topic.id));
  if (missing !== undefined) {
    return err({
      code: "escalation",
      gate: "relevance",
      message: `missing score for topic: ${missing.id}`,
      policy: { relevanceThreshold: policy.relevanceThreshold },
    });
  }
  return ok(
    topics.filter(
      (topic) =>
        (scores.get(topic.id) ?? -Infinity) >= policy.relevanceThreshold,
    ),
  );
};
