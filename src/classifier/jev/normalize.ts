import type { Assessment, Relationship, RelevanceResult, TopicId } from "../../schema";
import type { JevRequest, JevResponse } from "./wire";

export type AnswerTrace = {
  questionId: string;
  choice?: string;
  probability?: number;
  probabilities?: Record<string, number>;
  confidence?: number;
};

export const normalizeRelevance = (
  requests: JevRequest[],
  responses: JevResponse[],
): { result: RelevanceResult; trace: AnswerTrace[] } => {
  const topics: RelevanceResult["topics"] = [];
  const trace: AnswerTrace[] = [];
  requests.forEach((request, index) => {
    const response = responses[index];
    if (response === undefined) throw new Error("missing Jev batch response");
    for (const id of Object.keys(request.questions)) {
      const answer = response.answers[id];
      if (answer?.type !== "noul") throw new Error(`missing noul answer for ${id}`);
      topics.push({ topicId: id as TopicId, score: answer.noul });
      trace.push({ questionId: id, probability: answer.noul });
    }
  });
  return { result: { topics }, trace };
};

export const normalizeRelationships = (
  requests: JevRequest[],
  responses: JevResponse[],
): { result: Assessment; trace: AnswerTrace[] } => {
  const relations: Assessment["relations"] = [];
  let uncovered: Assessment["uncovered"] | undefined;
  const trace: AnswerTrace[] = [];
  requests.forEach((request, index) => {
    const response = responses[index];
    if (response === undefined) throw new Error("missing Jev batch response");
    for (const id of Object.keys(request.questions)) {
      const answer = response.answers[id];
      if (answer?.type !== "choice") throw new Error(`missing choice answer for ${id}`);
      trace.push({
        questionId: id,
        choice: answer.choice,
        probabilities: answer.probabilities,
        confidence: answer.confidence,
      });
      if (id === "uncovered") {
        uncovered = {
          outcome: answer.choice as Assessment["uncovered"]["outcome"],
          confidence: answer.confidence,
        };
      } else {
        relations.push({
          topicId: id as TopicId,
          relationship: answer.choice as Relationship,
          confidence: answer.confidence,
        });
      }
    }
  });
  if (uncovered === undefined) throw new Error("missing selected-topic answer: uncovered");
  return { result: { relations, uncovered }, trace };
};
