import { expect, test } from "bun:test";
import { parseCliArguments } from "./cli";

test("manual summary flags do not become transcript paths", () => {
  expect(parseCliArguments(["--tools"])).toEqual({ mode: "tools" });
  expect(parseCliArguments(["session.jsonl", "--tools"])).toEqual({
    transcript: "session.jsonl",
    mode: "tools",
  });
  expect(parseCliArguments(["--tools", "session.jsonl"])).toEqual({
    transcript: "session.jsonl",
    mode: "tools",
  });
});

test("manual summary arguments reject ambiguity", () => {
  expect(() => parseCliArguments(["--watch"])).toThrow("unknown option");
  expect(() => parseCliArguments(["one.jsonl", "two.jsonl"])).toThrow(
    "at most one transcript",
  );
});
