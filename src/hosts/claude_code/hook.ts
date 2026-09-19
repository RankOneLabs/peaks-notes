import { spawn } from "node:child_process";
import { openSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import { flagValues, SessionIdSchema } from "./arguments";
import { ContentModeSchema } from "./chunks";
import {
  prepareDirectories,
  recordPending,
  sessionPaths,
} from "./session_files";

/** Fields of Claude Code's Stop hook input that peaks reads. */
export const StopHookInputSchema = z.object({
  session_id: SessionIdSchema,
  transcript_path: z.string().min(1),
  cwd: z.string().min(1),
});

const HookArgumentsSchema = z
  .object({ mode: ContentModeSchema.default("chat") })
  .strict();

const PEAKS_ROOT = resolve(import.meta.dir, "../../..");
const WORKER = resolve(import.meta.dir, "worker.ts");

/**
 * Claude Code Stop hook. Records how far the transcript reached when the turn
 * ended, starts a detached worker, and returns without waiting. The worker
 * runs from the peaks checkout so Bun loads its `.env` model configuration.
 */
const main = async (): Promise<void> => {
  const { mode } = HookArgumentsSchema.parse(flagValues(process.argv.slice(2)));
  const input = StopHookInputSchema.parse(JSON.parse(await Bun.stdin.text()));
  const project = process.env.CLAUDE_PROJECT_DIR ?? input.cwd;
  const paths = sessionPaths(project, input.session_id);
  prepareDirectories(paths);
  recordPending(paths.pending, statSync(input.transcript_path).size);
  const output = openSync(paths.log, "a");
  spawn(
    process.execPath,
    [
      WORKER,
      "--session",
      input.session_id,
      "--transcript",
      input.transcript_path,
      "--project",
      project,
      "--mode",
      mode,
    ],
    { cwd: PEAKS_ROOT, detached: true, stdio: ["ignore", output, output] },
  ).unref();
};

// Exit code 2 would block Claude from stopping; failures here exit 1, which is non-blocking.
main().catch((cause: unknown) => {
  console.error(
    `peaks hook: ${cause instanceof Error ? cause.message : String(cause)}`,
  );
  process.exitCode = 1;
});
