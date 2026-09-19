import { expect, test } from "bun:test";
import type { Chunk } from "../../schema";
import { type ContentMode, turnChunks } from "./chunks";
import { parseTranscript } from "./transcript";

let sequence = 0;
const entry = (
  type: "user" | "assistant",
  content: unknown,
  extra: Record<string, unknown> = {},
) => {
  sequence += 1;
  return {
    type,
    uuid: `e${sequence}`,
    parentUuid: sequence === 1 ? null : `e${sequence - 1}`,
    timestamp: "2026-09-19T00:00:00.000Z",
    message: { role: type, content },
    ...extra,
  };
};
const prompt = (text: string) =>
  entry("user", text, { origin: { kind: "human" } });
const reply = (...blocks: unknown[]) => entry("assistant", blocks);
const toolUse = (id: string, name: string, input: unknown) =>
  reply({ type: "tool_use", id, name, input });
const toolResult = (id: string, content: string) =>
  entry("user", [{ type: "tool_result", tool_use_id: id, content }]);

const chunksOf = (mode: ContentMode, build: () => unknown[]): Chunk[] => {
  sequence = 0;
  const parsed = parseTranscript(
    `${build()
      .map((value) => JSON.stringify(value))
      .join("\n")}\n`,
  );
  if (!parsed.ok) throw new Error(parsed.error.message);
  const chunks = turnChunks(parsed.value.entries, mode);
  if (!chunks.ok) throw new Error(chunks.error.message);
  return chunks.value;
};

const session = () => [
  entry("user", "<command-name>/model</command-name>"),
  prompt("fix the build"),
  reply({ type: "thinking", thinking: "hidden" }),
  reply({ type: "text", text: "Looking at it." }),
  toolUse("t1", "Read", { file_path: "/repo/a.ts" }),
  toolResult("t1", "file body"),
  toolUse("t2", "Edit", {
    file_path: "/repo/a.ts",
    old_string: "x",
    new_string: "y",
  }),
  toolResult("t2", "updated"),
  toolUse("t3", "mcp__deploy__run", { target: "prod" }),
  toolResult("t3", "receipt 42"),
  entry("user", [{ type: "text", text: "Interrupted" }], { isMeta: true }),
  entry("user", "<task-notification>done</task-notification>", {
    origin: { kind: "task-notification" },
  }),
  reply({ type: "text", text: "Fixed." }),
  prompt("thanks"),
  reply({ type: "text", text: "Anytime." }),
];

test("chat mode keeps only the user's prompts and the assistant's text", () => {
  const chunks = chunksOf("chat", session);
  expect(
    chunks.map(({ messages }) =>
      messages.map(({ role, content }) => [role, content]),
    ),
  ).toEqual([
    [
      ["user", "fix the build"],
      ["assistant", "Looking at it."],
      ["assistant", "Fixed."],
    ],
    [
      ["user", "thanks"],
      ["assistant", "Anytime."],
    ],
  ]);
  expect(chunks[0]?.id).toBe("turn-e2" as Chunk["id"]);
});

test("tools mode adds paired tool records with host metadata", () => {
  const [first] = chunksOf("tools", session);
  const calls = (first?.messages ?? []).flatMap((message) =>
    "toolCall" in message ? [message.toolCall] : [],
  );
  expect(calls.map(({ name, action }) => [name, action])).toEqual([
    ["Read", { effect: "read_only" }],
    ["Edit", { effect: "state_changing", receiptArguments: ["file_path"] }],
    ["mcp__deploy__run", undefined],
  ]);
  expect(
    first?.messages
      .filter((message) => "toolResult" in message)
      .map(({ content }) => content),
  ).toEqual(["file body", "updated", "receipt 42"]);
});

test("tools mode drops a call whose result never arrived", () => {
  const [first] = chunksOf("tools", () => [
    prompt("run it"),
    toolUse("t1", "Bash", { command: "sleep 100" }),
    reply({ type: "text", text: "Stopped." }),
  ]);
  expect(first?.messages.map(({ content }) => content)).toEqual([
    "run it",
    "Stopped.",
  ]);
});

test("without origin fields, command output and interruptions are not prompts", () => {
  const chunks = chunksOf("chat", () => [
    entry("user", "real question"),
    reply({ type: "text", text: "answer" }),
    entry("user", "/compact"),
    entry("user", "<local-command-stdout>Compacted</local-command-stdout>"),
    entry("user", [{ type: "text", text: "[Request interrupted by user]" }]),
    entry("user", "next question"),
  ]);
  expect(chunks.map(({ messages }) => messages[0]?.content)).toEqual([
    "real question",
    "next question",
  ]);
});

test("the compaction summary is not a prompt", () => {
  const chunks = chunksOf("chat", () => [
    entry("user", "This session is being continued...", {
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
    }),
    prompt("carry on"),
  ]);
  expect(chunks.map(({ messages }) => messages[0]?.content)).toEqual([
    "carry on",
  ]);
});
