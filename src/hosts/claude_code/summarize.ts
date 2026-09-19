import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ingest, type PipelineDependencies } from "../../compact/ingest";
import { DEFAULT_WARNING_THRESHOLD, renderSummary } from "../../render/render";
import {
  err,
  type IngestResult,
  ok,
  type RenderResult,
  type Result,
  type TaskContext,
} from "../../schema";
import { type ContentMode, turnChunks } from "./chunks";
import { writeAtomically } from "./session_files";
import { parseTranscript, readTranscriptPrefix } from "./transcript";

export type SummarizeOptions = {
  sessionId: string;
  transcriptPath: string;
  /** Transcript size when the Stop hook fired; later bytes belong to a turn in progress. */
  untilBytes: number;
  summaryPath: string;
  mode: ContentMode;
  dependencies: PipelineDependencies;
  now?: () => Date;
};

export type Unprocessed = { chunkId: string; reason: string };

export type SummarizeReport = {
  results: IngestResult[];
  unprocessed: Unprocessed[];
  revision: number;
};

export type SummarizeError = { code: "summarize_error"; message: string };

const failure = (message: string): Result<never, SummarizeError> =>
  err({ code: "summarize_error", message });

const unprocessedReason = (result: IngestResult): string | undefined => {
  if (result.status === "retained") return result.reason;
  if (result.status === "budget_exceeded")
    return `summary would need ${result.required} tokens; the budget is ${result.budget}`;
  return undefined;
};

const markdown = (
  sessionId: string,
  title: string | undefined,
  revision: number,
  rendered: RenderResult,
  unprocessed: Unprocessed[],
  now: Date,
): string => {
  const lines = [
    `# ${title ?? "Claude Code session"}`,
    "",
    `Session \`${sessionId}\` · revision ${revision} · updated ${now.toISOString()}`,
    "",
  ];
  if (unprocessed.length > 0) {
    lines.push("> Turns not yet summarized; retried after the next turn:");
    for (const { chunkId, reason } of unprocessed)
      lines.push(`> - \`${chunkId}\`: ${reason}`);
    lines.push("");
  }
  lines.push(
    rendered.status === "rendered"
      ? rendered.content
      : `The summary needs ${rendered.required} tokens, over its ${rendered.budget}-token budget.`,
  );
  return `${lines.join("\n")}\n`;
};

/**
 * Summarizes every completed turn not yet processed, oldest first, then
 * rewrites the session's summary file. A turn that fails stays unprocessed
 * and is retried on the next run; later turns still proceed.
 */
export const summarizeSession = async (
  options: SummarizeOptions,
): Promise<Result<SummarizeReport, SummarizeError>> => {
  const transcript = parseTranscript(
    await readTranscriptPrefix(options.transcriptPath, options.untilBytes),
  );
  if (!transcript.ok) return failure(transcript.error.message);
  const chunks = turnChunks(transcript.value.entries, options.mode);
  if (!chunks.ok) return failure(chunks.error.message);

  const { dependencies } = options;
  const before = await dependencies.store.load();
  if (!before.ok) return failure(`load failed: ${before.error.message}`);
  const processed = new Set<string>(before.value.processedChunkIds);
  const taskContext: TaskContext = {
    currentTask: transcript.value.title ?? "Claude Code session",
    compactionInstructions: [],
  };

  const results: IngestResult[] = [];
  const unprocessed: Unprocessed[] = [];
  for (const chunk of chunks.value) {
    if (processed.has(chunk.id)) continue;
    const result = await ingest(chunk, taskContext, dependencies);
    results.push(result);
    const reason = unprocessedReason(result);
    if (reason !== undefined) unprocessed.push({ chunkId: chunk.id, reason });
  }

  const after = await dependencies.store.load();
  if (!after.ok) return failure(`load failed: ${after.error.message}`);
  const rendered = await renderSummary(
    after.value,
    {
      maxTokens: dependencies.budget.maxTokens,
      warningThreshold: DEFAULT_WARNING_THRESHOLD,
    },
    {
      tokenizer: dependencies.budget.tokenizer,
      summaryBudgetTokens: dependencies.budget.summaryBudgetTokens,
    },
  );
  mkdirSync(dirname(options.summaryPath), { recursive: true });
  writeAtomically(
    options.summaryPath,
    markdown(
      options.sessionId,
      transcript.value.title,
      after.value.revision,
      rendered,
      unprocessed,
      options.now?.() ?? new Date(),
    ),
  );
  return ok({ results, unprocessed, revision: after.value.revision });
};
