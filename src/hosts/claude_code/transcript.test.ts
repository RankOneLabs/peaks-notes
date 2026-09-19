import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTranscript, readTranscriptPrefix } from "./transcript";

const user = (uuid: string, parentUuid: string | null, content: string) => ({
  type: "user",
  uuid,
  parentUuid,
  timestamp: "2026-09-19T00:00:00.000Z",
  origin: { kind: "human" },
  message: { role: "user", content },
});

const assistant = (uuid: string, parentUuid: string, text: string) => ({
  type: "assistant",
  uuid,
  parentUuid,
  timestamp: "2026-09-19T00:00:01.000Z",
  message: { role: "assistant", content: [{ type: "text", text }] },
});

const jsonl = (...entries: unknown[]): string =>
  `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;

const uuids = (text: string): string[] => {
  const parsed = parseTranscript(text);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value.entries.map(({ uuid }) => uuid);
};

let directory: string | undefined;
afterEach(() => {
  if (directory !== undefined) rmSync(directory, { recursive: true });
  directory = undefined;
});

test("the active branch drops a rewound reply", () => {
  expect(
    uuids(
      jsonl(
        user("u1", null, "first"),
        assistant("a1", "u1", "abandoned"),
        assistant("a2", "u1", "kept"),
      ),
    ),
  ).toEqual(["u1", "a2"]);
});

test("the chain crosses a compaction boundary", () => {
  expect(
    uuids(
      jsonl(
        user("u1", null, "before"),
        assistant("a1", "u1", "reply"),
        {
          type: "system",
          subtype: "compact_boundary",
          uuid: "s1",
          parentUuid: null,
          logicalParentUuid: "a1",
        },
        user("u2", "s1", "after"),
      ),
    ),
  ).toEqual(["u1", "a1", "u2"]);
});

test("sidechain entries and non-message lines stay out", () => {
  expect(
    uuids(
      jsonl(
        { type: "ai-title", aiTitle: "Title", sessionId: "s" },
        user("u1", null, "main"),
        { ...assistant("side", "u1", "subagent"), isSidechain: true },
        assistant("a1", "u1", "reply"),
      ),
    ),
  ).toEqual(["u1", "a1"]);
});

test("the latest session title is kept", () => {
  const parsed = parseTranscript(
    jsonl({ type: "ai-title", aiTitle: "Old" }, user("u1", null, "hi"), {
      type: "ai-title",
      aiTitle: "New",
    }),
  );
  expect(parsed.ok && parsed.value.title).toBe("New");
});

test("an unreadable message entry is an error, not a silent gap", () => {
  const parsed = parseTranscript(
    jsonl({ type: "user", uuid: "u1", timestamp: "t" }),
  );
  expect(parsed.ok).toBe(false);
});

test("a malformed block of a type peaks reads is an error, not a silent gap", () => {
  const parsed = parseTranscript(
    jsonl(user("u1", null, "hi"), {
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      timestamp: "2026-09-19T00:00:01.000Z",
      message: { role: "assistant", content: [{ type: "tool_use", id: "t1" }] },
    }),
  );
  expect(parsed.ok).toBe(false);
});

test("a block type peaks does not read is kept as an opaque block", () => {
  expect(
    uuids(
      jsonl(user("u1", null, "hi"), {
        type: "assistant",
        uuid: "a1",
        parentUuid: "u1",
        timestamp: "2026-09-19T00:00:01.000Z",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "..." }],
        },
      }),
    ),
  ).toEqual(["u1", "a1"]);
});

test("reading a prefix leaves a partly written line for the next run", async () => {
  directory = mkdtempSync(join(tmpdir(), "peaks-transcript-"));
  const path = join(directory, "session.jsonl");
  const complete = jsonl(user("u1", null, "done"));
  writeFileSync(path, `${complete}{"type":"user","uu`);
  expect(await readTranscriptPrefix(path, complete.length + 10)).toBe(complete);
  expect(await readTranscriptPrefix(path, complete.length - 1)).toBe("");
});
