import { expect, test } from "bun:test";
import { normalizeRelationships, normalizeRelevance } from "./normalize";
import { JEV_MODEL, type JevRequest, parseJevResponse } from "./wire";

test("noul probability is the relevance score", () => {
  const request: JevRequest = {
    model: JEV_MODEL,
    state: "state",
    questions: { topic: { type: "noul", instructions: "related?" } },
  };
  const response = parseJevResponse(
    {
      answers: { topic: { type: "noul", noul: 0.72 } },
      usage: { input_tokens: 2, output_tokens: 1 },
    },
    request,
  );
  expect(
    normalizeRelevance([request], [response]).result.topics[0]?.score,
  ).toBe(0.72);
});

test("choice, distribution and confidence are retained", () => {
  const request: JevRequest = {
    model: JEV_MODEL,
    state: "state",
    questions: {
      topic: {
        type: "choice",
        instructions: "relationship?",
        criteria: {
          new_info: "new",
          changing_info: "changed",
          same_info: "same",
        },
      },
      uncovered: {
        type: "choice",
        instructions: "uncovered?",
        criteria: {
          none: "none",
          new_topic: "new",
          transient: "temporary",
          uncertain: "unclear",
        },
      },
    },
  };
  const response = parseJevResponse(
    {
      answers: {
        topic: {
          type: "choice",
          choice: "same_info",
          probabilities: { new_info: 0.1, changing_info: 0.1, same_info: 0.8 },
          confidence: 0.7,
        },
        uncovered: {
          type: "choice",
          choice: "none",
          probabilities: {
            none: 0.9,
            new_topic: 0.05,
            transient: 0.04,
            uncertain: 0.01,
          },
          confidence: 0.85,
        },
      },
      usage: { input_tokens: 2, output_tokens: 1 },
    },
    request,
  );
  const normalized = normalizeRelationships([request], [response]);
  expect(normalized.result.relations[0]).toMatchObject({
    relationship: "same_info",
    confidence: 0.7,
  });
  expect(normalized.trace[0]?.probabilities?.same_info).toBe(0.8);
});

test("invalid probabilities, choices and missing ids are rejected", () => {
  const request: JevRequest = {
    model: JEV_MODEL,
    state: "state",
    questions: { topic: { type: "noul", instructions: "related?" } },
  };
  expect(() =>
    parseJevResponse(
      {
        answers: { topic: { type: "noul", noul: 1.1 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      request,
    ),
  ).toThrow();
  expect(() =>
    parseJevResponse(
      { answers: {}, usage: { input_tokens: 1, output_tokens: 1 } },
      request,
    ),
  ).toThrow("missing question id");
});

test("choice outside the question criteria is rejected", () => {
  const request: JevRequest = {
    model: JEV_MODEL,
    state: "state",
    questions: {
      topic: {
        type: "choice",
        instructions: "relationship?",
        criteria: { new_info: "new", same_info: "same" },
      },
    },
  };
  expect(() =>
    parseJevResponse(
      {
        answers: {
          topic: {
            type: "choice",
            choice: "changing_info",
            probabilities: { new_info: 0.4, same_info: 0.6 },
            confidence: 0.2,
          },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      request,
    ),
  ).toThrow("choice outside criteria for question id: topic");
});

test("choice probabilities must form a complete normalized distribution", () => {
  const request: JevRequest = {
    model: JEV_MODEL,
    state: "state",
    questions: {
      topic: {
        type: "choice",
        instructions: "relationship?",
        criteria: { new_info: "new", same_info: "same" },
      },
    },
  };
  expect(() =>
    parseJevResponse(
      {
        answers: {
          topic: {
            type: "choice",
            choice: "new_info",
            probabilities: { new_info: 0.8, same_info: 0.8 },
            confidence: 0.2,
          },
        },
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      request,
    ),
  ).toThrow("invalid probability distribution");
});

test("response model must match the pinned Jev model", () => {
  const request: JevRequest = {
    model: JEV_MODEL,
    state: "state",
    questions: { topic: { type: "noul", instructions: "related?" } },
  };
  expect(() =>
    parseJevResponse(
      {
        model: "jev-latest",
        answers: { topic: { type: "noul", noul: 0.5 } },
        usage: { input_tokens: 1, output_tokens: 1 },
      },
      request,
    ),
  ).toThrow();
});
