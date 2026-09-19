import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

/** An empty lock file older than this lost its owner between create and write. */
const EMPTY_LOCK_GRACE_MS = 60_000;

export type SessionPaths = {
  directory: string;
  state: string;
  summary: string;
  database: string;
  pending: string;
  lock: string;
  log: string;
};

/** Summaries live in `<project>/peaks/`; working state in its ignored `.state/`. */
export const sessionPaths = (
  projectDir: string,
  sessionId: string,
): SessionPaths => {
  const directory = join(projectDir, "peaks");
  const state = join(directory, ".state");
  return {
    directory,
    state,
    summary: join(directory, `${sessionId}.md`),
    database: join(state, `${sessionId}.sqlite`),
    pending: join(state, `${sessionId}.pending`),
    lock: join(state, `${sessionId}.lock`),
    log: join(state, `${sessionId}.log`),
  };
};

export const prepareDirectories = (paths: SessionPaths): void => {
  mkdirSync(paths.state, { recursive: true });
  const ignore = join(paths.directory, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, ".state/\n");
};

export const writeAtomically = (path: string, content: string): void => {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, path);
};

/** The transcript size at the latest Stop; the worker summarizes up to it. */
export const readPending = (path: string): number => {
  if (!existsSync(path)) return 0;
  const value = Number(readFileSync(path, "utf8"));
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
};

/** Transcripts only grow, so a smaller size never replaces a larger one. */
export const recordPending = (path: string, bytes: number): void => {
  if (bytes > readPending(path)) writeAtomically(path, String(bytes));
};

const errorCode = (cause: unknown): string | undefined =>
  (cause as { code?: string } | undefined)?.code;

const ownerAlive = (path: string): boolean => {
  let content: string;
  let modified: number;
  try {
    content = readFileSync(path, "utf8").trim();
    modified = statSync(path).mtimeMs;
  } catch {
    return false;
  }
  if (content === "") return Date.now() - modified < EMPTY_LOCK_GRACE_MS;
  const pid = Number(content);
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return errorCode(cause) === "EPERM";
  }
};

/** One worker per session; a lock whose owner has exited is taken over. */
export const acquireLock = (path: string): boolean => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const descriptor = openSync(path, "wx");
      writeSync(descriptor, String(process.pid));
      closeSync(descriptor);
      return true;
    } catch (cause) {
      if (errorCode(cause) !== "EEXIST") throw cause;
      if (ownerAlive(path)) return false;
      try {
        unlinkSync(path);
      } catch {
        // Another worker removed it first; the next attempt settles who owns it.
      }
    }
  }
  return false;
};

export const releaseLock = (path: string): void => {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
};
