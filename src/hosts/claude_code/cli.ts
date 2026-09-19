import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createConfiguredAdapters } from "../../adapters";
import { loadConfig } from "../../config";
import { SqliteStore } from "../../store/sqlite";
import { ContentModeSchema } from "./chunks";
import { prepareDirectories, sessionPaths } from "./session_files";
import { summarizeSession } from "./summarize";
import { sessionDependencies } from "./worker";

const TRANSCRIPTS = join(homedir(), ".claude", "projects");

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
  const [given, ...rest] = process.argv.slice(2);
  const mode = ContentModeSchema.parse(
    rest.includes("--tools") ? "tools" : "chat",
  );
  const transcript = given === undefined ? latestTranscript() : resolve(given);
  const session = basename(transcript, ".jsonl");
  const paths = sessionPaths(process.cwd(), session);
  prepareDirectories(paths);

  const bytes = statSync(transcript).size;
  console.log(`reading ${transcript} (${bytes} bytes, ${mode})`);
  const store = new SqliteStore(paths.database);
  try {
    const report = await summarizeSession({
      sessionId: session,
      transcriptPath: transcript,
      untilBytes: bytes,
      summaryPath: paths.summary,
      mode,
      dependencies: sessionDependencies(
        session,
        store,
        loadConfig(),
        createConfiguredAdapters(loadConfig()),
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
    store.close();
  }
};

if (import.meta.main)
  main().catch((cause: unknown) => {
    console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  });
