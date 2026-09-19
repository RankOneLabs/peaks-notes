import { expect, test } from "bun:test";
import type { Memory, Message, Tokenizer } from "../schema";
import { StubWriter } from "../writer/stub";
import { renderContext } from "./render";
import { SECTION_HEADINGS } from "./sections";

const memory: Memory = {
  revision: 1,
  topics: [
    {
      id: "topic-1" as never,
      title: "Network",
      description: "Network",
      version: 1,
      summary: "LAN only",
      sources: [{ messageId: "source-1" as never }],
      unresolved: ["Is Wi-Fi allowed?"],
    },
  ],
  protected: [
    {
      id: "protected-1" as never,
      kind: "constraint",
      text: "Never use the public internet.",
      sources: [{ messageId: "source-1" as never }],
      status: "active",
    },
  ],
  processedChunkIds: [],
};
const recent: Message[] = [
  { id: "recent-1" as never, role: "user", content: "Continue." },
];

test("renders sections in specification order and counts the whole output", async () => {
  const result = await renderContext(
    memory,
    recent,
    { maxTokens: 10_000, warningThreshold: 0.8 },
    {
      taskContext: {
        currentTask: "Configure",
        compactionInstructions: ["Be exact"],
      },
    },
  );
  expect(result.status).toBe("rendered");
  if (result.status !== "rendered") return;
  const positions = Object.values(SECTION_HEADINGS).map((heading) =>
    result.content.indexOf(heading),
  );
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(result.content).toContain("Never use the public internet.");
});

test("sets warning above 80 percent of summary budget", async () => {
  const tokenizer: Tokenizer = {
    count: (text) => ({
      tokens: text.includes("## Topic summaries") ? 81 : 90,
      method: "target_tokenizer",
    }),
  };
  const result = await renderContext(
    memory,
    [],
    { maxTokens: 1000, warningThreshold: 0.8 },
    { tokenizer, summaryBudgetTokens: 100 },
  );
  expect(result.status === "rendered" && result.warning).toBe(true);
});

test("attempts unchanged compression once then returns budget_exceeded without mutation", async () => {
  const before = structuredClone(memory);
  const writer = new StubWriter({
    compressions: [
      {
        output: {
          replacements: [
            {
              topicId: "topic-1" as never,
              expectedVersion: 1,
              title: "Network",
              description: "Network",
              summary: "LAN only",
              sources: [{ messageId: "source-1" as never }],
              unresolved: ["Is Wi-Fi allowed?"],
            },
          ],
          newTopics: [],
          addProtected: [],
          supersedeProtected: [],
        },
      },
    ],
  });
  const result = await renderContext(
    memory,
    recent,
    { maxTokens: 1, warningThreshold: 0.8 },
    { writer },
  );
  expect(result.status).toBe("budget_exceeded");
  expect(writer.compressCalls).toHaveLength(1);
  expect(memory).toEqual(before);
});

test("rejects compression that removes an unresolved conflict", async () => {
  const writer = new StubWriter({
    compressions: [
      {
        output: {
          replacements: [
            {
              topicId: "topic-1" as never,
              expectedVersion: 1,
              title: "Network",
              description: "Network",
              summary: "x",
              sources: [{ messageId: "source-1" as never }],
              unresolved: [],
            },
          ],
          newTopics: [],
          addProtected: [],
          supersedeProtected: [],
        },
      },
    ],
  });
  const tokenizer: Tokenizer = {
    count: (text) => ({
      tokens: text.includes("LAN only") ? 100 : 1,
      method: "target_tokenizer",
    }),
  };
  const result = await renderContext(
    memory,
    [],
    { maxTokens: 50, warningThreshold: 0.8 },
    { writer, tokenizer },
  );
  expect(result.status).toBe("budget_exceeded");
  expect(writer.compressCalls).toHaveLength(1);
});
