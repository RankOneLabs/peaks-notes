import { expect, test } from "bun:test";
import type { RelationshipInput, RelevanceInput } from "../../schema";
import { relationshipQuestions, relevanceQuestions } from "./questions";

const chunk = {
  id: "chunk-1" as never,
  createdAt: "2026-09-18T00:00:00.000Z",
  messages: [
    { id: "message-1" as never, role: "user" as const, content: "LAN update" },
  ],
};
const taskContext = {
  currentTask: "configure LAN",
  compactionInstructions: ["keep IPs"],
};

test("relevance has one noul question keyed by topic id", () => {
  const input: RelevanceInput = {
    chunk,
    taskContext,
    topics: [
      {
        id: "topic-network" as never,
        title: "Network",
        description: "LAN facts",
      },
    ],
  };
  const built = relevanceQuestions(input);
  expect(Object.keys(built.questions)).toEqual(["topic-network"]);
  expect(built.questions["topic-network"]).toMatchObject({
    type: "noul",
    instructions: expect.stringContaining("Topic title: Network"),
  });
  expect(built.state).toContain("<transcript-data>");
});

test("relationships carry full summaries and uncovered carries full catalog", () => {
  const input: RelationshipInput = {
    chunk,
    taskContext,
    selectedTopics: [
      {
        id: "topic-network" as never,
        title: "Network",
        description: "LAN facts",
        version: 1,
        summary: "Exact complete summary 192.168.1.2",
        sources: [],
        unresolved: [],
      },
    ],
    topicCatalog: [
      {
        id: "topic-network" as never,
        title: "Network",
        description: "LAN facts",
      },
    ],
    protectedRecords: [],
  };
  const built = relationshipQuestions(input);
  expect(built.questions["topic-network"]).toMatchObject({
    type: "choice",
    instructions: expect.stringContaining("Exact complete summary 192.168.1.2"),
  });
  expect(built.questions.uncovered).toMatchObject({
    type: "choice",
    instructions: expect.stringContaining("topic-network"),
  });
});
