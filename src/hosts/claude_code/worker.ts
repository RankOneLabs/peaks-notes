import { z } from "zod";
import { createConfiguredAdapters } from "../../adapters";
import type { PipelineDependencies } from "../../compact/ingest";
import { loadConfig } from "../../config";
import { ConservativeTokenizer } from "../../render/estimate_tokens";
import type { ClassifierPolicy } from "../../schema";
import { SqliteStore } from "../../store/sqlite";
import { flagValues, SessionIdSchema } from "./arguments";
import { ContentModeSchema } from "./chunks";
import {
  acquireLock,
  prepareDirectories,
  readPending,
  releaseLock,
  sessionPaths,
} from "./session_files";
import { summarizeSession } from "./summarize";

/** Spec §6 suggested settings: 4,000 topic tokens inside a 6,000-token summary. */
const SUMMARY_MAX_TOKENS = 6_000;
const SUMMARY_TOPIC_TOKENS = 4_000;

/** Shadow mode only logs classifier decisions, so these untuned values never gate a write. */
const SHADOW_CLASSIFIER_POLICY: ClassifierPolicy = {
  relevanceThreshold: 0.5,
  sameInfoMinConfidence: 0.8,
  uncoveredNoChangeMinConfidence: 0.8,
};

export const WorkerArgumentsSchema = z
  .object({
    session: SessionIdSchema,
    transcript: z.string().min(1),
    project: z.string().min(1),
    mode: ContentModeSchema.default("chat"),
  })
  .strict();
export type WorkerArguments = z.infer<typeof WorkerArgumentsSchema>;

/** The pipeline every Claude Code entry point runs: shadow mode, §6 budgets. */
export const sessionDependencies = (
  session: string,
  store: SqliteStore,
  config: ReturnType<typeof loadConfig>,
  adapters: ReturnType<typeof createConfiguredAdapters>,
): PipelineDependencies => ({
  store,
  classifier: adapters.classifier,
  writer: adapters.writer,
  evaluator: adapters.evaluator,
  classifierPolicy: SHADOW_CLASSIFIER_POLICY,
  executionPolicy: { mode: "shadow", bypassAuditRate: 0, auditSeed: session },
  auditDeadlineMs: config.evaluation.auditDeadlineMs,
  shadowComparisonDeadlineMs: config.evaluation.shadowComparisonDeadlineMs,
  budget: {
    maxTokens: SUMMARY_MAX_TOKENS,
    summaryBudgetTokens: SUMMARY_TOPIC_TOKENS,
    tokenizer: new ConservativeTokenizer(),
  },
});

const log = (message: string): void =>
  console.log(`${new Date().toISOString()} ${message}`);

/**
 * Summarizes until no newer Stop is pending. After releasing the lock it
 * checks once more, so a Stop recorded while this worker held the lock is
 * never stranded when that Stop's own worker lost the lock race.
 */
export const runWorker = async (args: WorkerArguments): Promise<void> => {
  const paths = sessionPaths(args.project, args.session);
  prepareDirectories(paths);
  const config = loadConfig();
  const adapters = createConfiguredAdapters(config);
  let done = 0;
  while (readPending(paths.pending) > done) {
    if (!acquireLock(paths.lock)) return;
    let store: SqliteStore | undefined;
    try {
      store = new SqliteStore(paths.database);
      const dependencies = sessionDependencies(
        args.session,
        store,
        config,
        adapters,
      );
      for (
        let target = readPending(paths.pending);
        target > done;
        target = readPending(paths.pending)
      ) {
        const report = await summarizeSession({
          sessionId: args.session,
          transcriptPath: args.transcript,
          untilBytes: target,
          summaryPath: paths.summary,
          mode: args.mode,
          dependencies,
        });
        done = target;
        if (!report.ok) {
          log(`failed at ${target} bytes: ${report.error.message}`);
          continue;
        }
        const statuses = report.value.results.map(({ status }) => status);
        log(
          `summarized to ${target} bytes (${args.mode}): revision ${report.value.revision}, ` +
            `${statuses.length} turns [${statuses.join(", ")}], ${report.value.unprocessed.length} unprocessed`,
        );
        for (const { chunkId, reason } of report.value.unprocessed)
          log(`unprocessed ${chunkId}: ${reason}`);
      }
    } finally {
      store?.close();
      releaseLock(paths.lock);
    }
  }
};

if (import.meta.main)
  runWorker(
    WorkerArgumentsSchema.parse(flagValues(process.argv.slice(2))),
  ).catch((cause: unknown) => {
    log(
      cause instanceof Error ? (cause.stack ?? cause.message) : String(cause),
    );
    process.exitCode = 1;
  });
