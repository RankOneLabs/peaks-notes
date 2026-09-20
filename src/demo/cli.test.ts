import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { turnChunks } from "../hosts/claude_code/chunks";
import { parseTranscript } from "../hosts/claude_code/transcript";
import { completedTurnOffsets } from "./cli";

const fixture = readFileSync("fixtures/demo/incident-response.jsonl", "utf8");

test("the demo submits a sustained sixteen-turn discussion in tools mode", () => {
  expect(completedTurnOffsets(fixture)).toHaveLength(16);
  const parsed = parseTranscript(fixture);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const chunks = turnChunks(parsed.value.entries, "tools");
  if (!chunks.ok) throw new Error(chunks.error.message);
  expect(chunks.value).toHaveLength(16);
  expect(
    chunks.value[0]?.messages.filter((message) => "toolCall" in message),
  ).toHaveLength(2);
  expect(
    chunks.value[6]?.messages.filter((message) => "toolCall" in message),
  ).toHaveLength(3);
  expect(
    chunks.value[9]?.messages.filter((message) => "toolCall" in message),
  ).toHaveLength(1);
  expect(
    chunks.value
      .flatMap(({ messages }) => messages)
      .filter((message) => "toolCall" in message),
  ).toHaveLength(6);
});
