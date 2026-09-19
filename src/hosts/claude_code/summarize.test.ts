import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StubClassifier } from "../../classifier/stub";
import { StubEvaluator } from "../../evaluator/stub";
import { ConservativeTokenizer } from "../../render/estimate_tokens";
import type { StubResponse } from "../../replay/fixture";
import type { MemoryPatch } from "../../schema";
import { SqliteStore } from "../../store/sqlite";
import { StubWriter } from "../../writer/stub";
import { summarizeSession } from "./summarize";

const line = (value: unknown): string => `${JSON.stringify(value)}\n`;
const prompt = (uuid: string, parentUuid: string | null, content: string) =>
  line({
    type: "user",
    uuid,
    parentUuid,
    timestamp: "2026-09-19T00:00:00.000Z",
    origin: { kind: "human" },
    message: { role: "user", content },
  });
const reply = (uuid: string, parentUuid: string, text: string) =>
  line({
    type: "assistant",
    uuid,
    parentUuid,
    timestamp: "2026-09-19T00:00:01.000Z",
    message: { role: "assistant", content: [{ type: "text", text }] },
  });

const firstTurn =
  line({ type: "ai-title", aiTitle: "Service setup" }) +
  prompt("u1", null, "The API runs on port 8080.") +
  reply("a1", "u1", "Noted, port 8080.");
const secondTurn =
  prompt("u2", "a1", "It talks to Postgres on willie.") +
  reply("a2", "u2", "Noted, Postgres on willie.");

const newTopic = (
  summary: string,
  messageId: string,
): StubResponse<MemoryPatch> => ({
  output: {
    replacements: [],
    newTopics: [
      {
        title: "Service config",
        description: "How the API is deployed",
        summary,
        sources: [{ messageId: messageId as never }],
        unresolved: [],
      },
    ],
    addProtected: [],
    supersedeProtected: [],
  },
});

let directory: string;
let store: SqliteStore;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "peaks-summarize-"));
  store = new SqliteStore(":memory:");
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true });
});

const run = (
  transcript: string,
  writer: StubWriter,
  untilBytes = transcript.length,
) => {
  const transcriptPath = join(directory, "session.jsonl");
  writeFileSync(transcriptPath, transcript);
  return summarizeSession({
    sessionId: "session-1",
    transcriptPath,
    untilBytes,
    summaryPath: join(directory, "peaks", "session-1.md"),
    mode: "chat",
    now: () => new Date("2026-09-19T12:00:00.000Z"),
    dependencies: {
      store,
      classifier: new StubClassifier(),
      writer,
      evaluator: new StubEvaluator(),
      classifierPolicy: {
        relevanceThreshold: 0.5,
        sameInfoMinConfidence: 0.8,
        uncoveredNoChangeMinConfidence: 0.8,
      },
      executionPolicy: { mode: "shadow", bypassAuditRate: 0, auditSeed: "s" },
      budget: {
        maxTokens: 6_000,
        summaryBudgetTokens: 4_000,
        tokenizer: new ConservativeTokenizer(),
      },
    },
  });
};

const summaryFile = () =>
  readFileSync(join(directory, "peaks", "session-1.md"), "utf8");

test("a completed turn is summarized into the session file", async () => {
  const writer = new StubWriter({
    proposals: [newTopic("The API runs on port 8080.", "u1")],
  });
  const report = await run(firstTurn, writer);
  expect(report.ok && report.value.results.map(({ status }) => status)).toEqual(
    ["committed"],
  );
  const summary = summaryFile();
  expect(summary).toStartWith("# Service setup\n");
  expect(summary).toContain("revision 1");
  expect(summary).toContain("The API runs on port 8080.");
  expect(
    writer.proposeCalls[0]?.chunk.messages.map(({ content }) => content),
  ).toEqual(["The API runs on port 8080.", "Noted, port 8080."]);
});

test("a rerun at the same size does not resummarize", async () => {
  const writer = new StubWriter({
    proposals: [newTopic("The API runs on port 8080.", "u1")],
  });
  await run(firstTurn, writer);
  const again = await run(firstTurn, writer);
  expect(again.ok && again.value.results).toEqual([]);
  expect(writer.proposeCalls).toHaveLength(1);
});

test("bytes written after the Stop are left for the next run", async () => {
  const writer = new StubWriter({
    proposals: [newTopic("The API runs on port 8080.", "u1")],
  });
  const report = await run(firstTurn + secondTurn, writer, firstTurn.length);
  expect(report.ok && report.value.results).toHaveLength(1);
  expect(writer.proposeCalls[0]?.chunk.id).toBe("turn-u1" as never);
});

test("a failed turn stays listed while later turns proceed", async () => {
  const writer = new StubWriter({
    proposals: [
      { error: "provider unavailable" },
      newTopic("The API uses Postgres on willie.", "u2"),
    ],
  });
  const report = await run(firstTurn + secondTurn, writer);
  expect(report.ok && report.value.results.map(({ status }) => status)).toEqual(
    ["retained", "committed"],
  );
  const summary = summaryFile();
  expect(summary).toContain("`turn-u1`");
  expect(summary).toContain("provider unavailable");
  expect(summary).toContain("The API uses Postgres on willie.");
});
