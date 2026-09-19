import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createConfiguredAdapters } from "../../adapters";
import { SqliteStore } from "../../store/sqlite";
import { ContentModeSchema } from "./chunks";
import { loadSessionConfig } from "./session_config";
import {
  acquireLock,
  prepareDirectories,
  releaseLock,
  sessionPaths,
} from "./session_files";
import { summarizeSession } from "./summarize";
import { sessionDependencies } from "./worker";

const TRANSCRIPTS = join(homedir(), ".claude", "projects");

export type CliArguments = {
  transcript?: string;
  mode: "chat" | "tools";
};

/** Accept one optional transcript path and an order-independent --tools flag. */
export const parseCliArguments = (args: string[]): CliArguments => {
  let transcript: string | undefined;
  let mode: "chat" | "tools" = "chat";
  for (const argument of args) {
    if (argument === "--tools") {
      mode = "tools";
      continue;
    }
    if (argument.startsWith("--"))
      throw new Error(`unknown option: ${argument}`);
    if (transcript !== undefined)
      throw new Error("expected at most one transcript path");
    transcript = argument;
  }
  return transcript === undefined ? { mode } : { transcript, mode };
};

/** The session Claude Code wrote to most recently, across every project. */
const latestTranscript = (): string => {
  let newest: { path: string; modified: number } | undefined;
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith(".jsonl")) continue;
      const modified = statSync(path).mtimeMs;
      if (newest === undefined || modified > newest.modified)
        newest = { path, modified };
    }
  };
  walk(TRANSCRIPTS);
  if (newest === undefined)
    throw new Error(`no transcripts under ${TRANSCRIPTS}`);
  return newest.path;
};

/**
 * Summarizes one transcript in the foreground and prints the summary path.
 * The Stop hook does the same work in the background; this is the way to run
 * it by hand, against any session, without installing anything.
 */
const main = async (): Promise<void> => {
  const args = parseCliArguments(process.argv.slice(2));
  const mode = ContentModeSchema.parse(args.mode);
  const transcript =
    args.transcript === undefined
      ? latestTranscript()
      : resolve(args.transcript);
  const session = basename(transcript, ".jsonl");
  const paths = sessionPaths(process.cwd(), session);
  prepareDirectories(paths);

  const bytes = statSync(transcript).size;
  console.log(`reading ${transcript} (${bytes} bytes, ${mode})`);
  if (!acquireLock(paths.lock))
    throw new Error(`session ${session} is already being summarized`);
  let store: SqliteStore | undefined;
  try {
    store = new SqliteStore(paths.database);
    const config = loadSessionConfig();
    const report = await summarizeSession({
      sessionId: session,
      transcriptPath: transcript,
      untilBytes: bytes,
      summaryPath: paths.summary,
      mode,
      dependencies: sessionDependencies(
        session,
        store,
        config,
        createConfiguredAdapters(config),
      ),
    });
    if (!report.ok) {
      console.error(report.error.message);
      process.exitCode = 1;
      return;
    }
    const statuses = report.value.results.map(({ status }) => status);
    console.log(
      `revision ${report.value.revision}, ${statuses.length} turns [${statuses.join(", ")}]`,
    );
    for (const { chunkId, reason } of report.value.unprocessed)
      console.log(`unprocessed ${chunkId}: ${reason}`);
    console.log(`\n${await Bun.file(paths.summary).text()}`);
    console.log(paths.summary);
  } finally {
    store?.close();
    releaseLock(paths.lock);
  }
};

if (import.meta.main)
  main().catch((cause: unknown) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  });
