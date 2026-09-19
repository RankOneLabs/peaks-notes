import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLock,
  prepareDirectories,
  readPending,
  recordPending,
  releaseLock,
  sessionPaths,
} from "./session_files";

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "peaks-session-"));
});
afterEach(() => rmSync(directory, { recursive: true }));

test("a held lock refuses a second owner until released", () => {
  const lock = join(directory, "s.lock");
  expect(acquireLock(lock)).toBe(true);
  expect(acquireLock(lock)).toBe(false);
  releaseLock(lock);
  expect(existsSync(lock)).toBe(false);
  expect(acquireLock(lock)).toBe(true);
});

test("a lock whose owner has exited is taken over", () => {
  const lock = join(directory, "s.lock");
  const exited = Bun.spawnSync(["true"]).pid;
  writeFileSync(lock, String(exited));
  expect(acquireLock(lock)).toBe(true);
});

test("working state is ignored even when the project wrote its own rules", () => {
  const paths = sessionPaths(directory, "s");
  mkdirSync(paths.directory, { recursive: true });
  const ignore = join(paths.directory, ".gitignore");
  writeFileSync(ignore, "*.tmp");

  prepareDirectories(paths);

  const lines = readFileSync(ignore, "utf8").split("\n");
  expect(lines).toContain("*.tmp");
  expect(lines).toContain(".state/");
});

test("the ignore rule is not added twice", () => {
  const paths = sessionPaths(directory, "s");
  prepareDirectories(paths);
  prepareDirectories(paths);

  const ignore = readFileSync(join(paths.directory, ".gitignore"), "utf8");
  expect(ignore).toBe(".state/\n");
});

test("pending size only grows", () => {
  const pending = join(directory, "s.pending");
  expect(readPending(pending)).toBe(0);
  recordPending(pending, 200);
  recordPending(pending, 100);
  expect(readPending(pending)).toBe(200);
});
