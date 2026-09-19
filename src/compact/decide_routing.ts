import type {
  Assessment,
  ClassifierPolicy,
  Result,
  Topic,
  TopicId,
} from "../schema";
import { err, ok } from "../schema";
import type { CompactEscalation } from "./select_topics";

export type RoutingDecision =
  | { kind: "writer"; affectedTopicIds: TopicId[]; reason: string }
  | { kind: "bypass"; affectedTopicIds: TopicId[]; reason: string };

const rank = { same_info: 0, new_info: 1, changing_info: 2 } as const;

export const decideRouting = (
  selectedTopics: readonly Topic[],
  assessment: Assessment,
  policy: ClassifierPolicy,
): Result<RoutingDecision, CompactEscalation> => {
  const selected = new Set(selectedTopics.map(({ id }) => id));
  const relations = new Map<string, Assessment["relations"][number]>();
  for (const relation of assessment.relations) {
    if (!selected.has(relation.topicId)) {
      return err({
        code: "escalation",
        gate: "relationship",
        message: `relationship for unselected topic: ${relation.topicId}`,
        policy: {
          sameInfoMinConfidence: policy.sameInfoMinConfidence,
          uncoveredNoChangeMinConfidence: policy.uncoveredNoChangeMinConfidence,
        },
      });
    }
    if (!Number.isFinite(relation.confidence)) {
      return err({
        code: "escalation",
        gate: "relationship",
        message: `invalid confidence for topic: ${relation.topicId}`,
        policy: { sameInfoMinConfidence: policy.sameInfoMinConfidence },
      });
    }
    const current = relations.get(relation.topicId);
    if (
      current === undefined ||
      rank[relation.relationship] > rank[current.relationship]
    ) {
      relations.set(relation.topicId, relation);
    }
  }
  const missing = selectedTopics.find((topic) => !relations.has(topic.id));
  if (missing !== undefined) {
    return err({
      code: "escalation",
      gate: "relationship",
      message: `missing relationship for topic: ${missing.id}`,
      policy: { sameInfoMinConfidence: policy.sameInfoMinConfidence },
    });
  }
  if (!Number.isFinite(assessment.uncovered.confidence)) {
    return err({
      code: "escalation",
      gate: "relationship",
      message: "invalid uncovered confidence",
      policy: {
        uncoveredNoChangeMinConfidence: policy.uncoveredNoChangeMinConfidence,
      },
    });
  }

  const ids = selectedTopics.map(({ id }) => id);
  if (
    [...relations.values()].some(
      ({ relationship }) => relationship !== "same_info",
    )
  ) {
    return ok({
      kind: "writer",
      affectedTopicIds: ids,
      reason: "new_or_changing_info",
    });
  }
  if (
    [...relations.values()].some(
      ({ confidence }) => confidence < policy.sameInfoMinConfidence,
    )
  ) {
    return ok({
      kind: "writer",
      affectedTopicIds: ids,
      reason: "low_confidence_same_info",
    });
  }
  if (
    assessment.uncovered.outcome === "new_topic" ||
    assessment.uncovered.outcome === "uncertain"
  ) {
    return ok({
      kind: "writer",
      affectedTopicIds: ids,
      reason: `uncovered_${assessment.uncovered.outcome}`,
    });
  }
  if (assessment.uncovered.confidence < policy.uncoveredNoChangeMinConfidence) {
    return ok({
      kind: "writer",
      affectedTopicIds: ids,
      reason: "low_confidence_uncovered",
    });
  }
  return ok({
    kind: "bypass",
    affectedTopicIds: ids,
    reason: `same_info_and_uncovered_${assessment.uncovered.outcome}`,
  });
};
