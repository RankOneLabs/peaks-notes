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

const rank = {
  same_info: 0,
  no_meaningful_addition: 0,
  new_info: 1,
  changing_info: 2,
} as const;

const isNoUpdateRelationship = (
  relationship: Assessment["relations"][number]["relationship"],
): boolean =>
  relationship === "same_info" || relationship === "no_meaningful_addition";

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
      rank[relation.relationship] > rank[current.relationship] ||
      (rank[relation.relationship] === rank[current.relationship] &&
        relation.confidence < current.confidence)
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
      ({ relationship }) => !isNoUpdateRelationship(relationship),
    )
  ) {
    return ok({
      kind: "writer",
      affectedTopicIds: ids,
      reason: "new_or_changing_info",
    });
  }
  const lowConfidenceRelation = [...relations.values()].find(
    ({ confidence }) => confidence < policy.sameInfoMinConfidence,
  );
  if (lowConfidenceRelation !== undefined) {
    return ok({
      kind: "writer",
      affectedTopicIds: ids,
      reason: `low_confidence_${lowConfidenceRelation.relationship}`,
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
  const onlyNoMeaningfulAdditions =
    relations.size > 0 &&
    [...relations.values()].every(
      ({ relationship }) => relationship === "no_meaningful_addition",
    );
  return ok({
    kind: "bypass",
    affectedTopicIds: ids,
    reason: `${onlyNoMeaningfulAdditions ? "no_meaningful_addition" : "same_info"}_and_uncovered_${assessment.uncovered.outcome}`,
  });
};
