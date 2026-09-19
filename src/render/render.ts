import { applyPatch } from "../compact/apply_patch";
import type {
  Memory,
  Message,
  RenderResult,
  TaskContext,
  TokenBudget,
  Tokenizer,
  Writer,
} from "../schema";
import { MemoryPatchSchema } from "../schema";
import { budgetResult } from "./budget";
import { ConservativeTokenizer } from "./estimate_tokens";
import { recentWindow } from "./recent_window";
import {
  renderProtectedSection,
  renderRecentSection,
  renderTaskSection,
  renderTopicsSection,
} from "./sections";

export const DEFAULT_SUMMARY_TOKEN_BUDGET = 4_000;
export const DEFAULT_WARNING_THRESHOLD = 0.8;

export type RecentRaw =
  | readonly Message[]
  | { messages: readonly Message[]; retainedFailures?: readonly Message[] };

export type RenderOptions = {
  taskContext?: TaskContext;
  tokenizer?: Tokenizer;
  writer?: Writer;
  summaryBudgetTokens?: number;
  recentMessageCount?: number;
};

const collectRecent = (recentRaw: RecentRaw, count?: number): Message[] => {
  const isCollection = (value: RecentRaw): value is readonly Message[] =>
    Array.isArray(value);
  const messages = isCollection(recentRaw) ? recentRaw : recentRaw.messages;
  const retained = isCollection(recentRaw)
    ? []
    : (recentRaw.retainedFailures ?? []);
  const window = recentWindow(messages, count);
  const ids = new Set(window.map(({ id }) => id));
  return [
    ...structuredClone([...retained]).filter(({ id }) => !ids.has(id)),
    ...window,
  ];
};

const contentFor = (
  memory: Memory,
  recent: readonly Message[],
  taskContext: TaskContext,
): { content: string; topics: string } => {
  const topics = renderTopicsSection(memory);
  return {
    topics,
    content: [
      renderTaskSection(taskContext),
      renderProtectedSection(memory),
      topics,
      renderRecentSection(recent),
    ].join("\n\n"),
  };
};

const compressedMemory = async (
  memory: Memory,
  taskContext: TaskContext,
  writer: Writer,
  maxSummaryTokens: number,
): Promise<Memory | undefined> => {
  const candidate = MemoryPatchSchema.safeParse(
    await writer.compress({
      memory: structuredClone(memory),
      taskContext,
      maxSummaryTokens,
    }),
  );
  if (!candidate.success) return undefined;
  const patch = candidate.data;
  if (
    patch.newTopics.length > 0 ||
    patch.addProtected.length > 0 ||
    patch.supersedeProtected.length > 0
  )
    return undefined;
  const topics = new Map(
    memory.topics.map((topic) => [topic.id, topic.version]),
  );
  if (
    patch.replacements.some(
      ({ topicId, expectedVersion }) => topics.get(topicId) !== expectedVersion,
    )
  )
    return undefined;
  const allowedSources = new Set(
    memory.topics.flatMap((topic) =>
      topic.sources.map(({ messageId }) => messageId),
    ),
  );
  if (
    patch.replacements.some(({ sources }) =>
      sources.some(({ messageId }) => !allowedSources.has(messageId)),
    )
  )
    return undefined;
  return applyPatch(memory, patch);
};

export const renderContext = async (
  memory: Memory,
  recentRaw: RecentRaw,
  budget: TokenBudget,
  options: RenderOptions = {},
): Promise<RenderResult> => {
  const tokenizer = options.tokenizer ?? new ConservativeTokenizer();
  const taskContext = options.taskContext ?? {
    currentTask: "",
    compactionInstructions: [],
  };
  const summaryBudget =
    options.summaryBudgetTokens ?? DEFAULT_SUMMARY_TOKEN_BUDGET;
  const recent = collectRecent(recentRaw, options.recentMessageCount);
  const first = contentFor(memory, recent, taskContext);
  const warning =
    tokenizer.count(first.topics).tokens >
    summaryBudget * (budget.warningThreshold ?? DEFAULT_WARNING_THRESHOLD);
  const firstResult = budgetResult(first.content, budget, tokenizer, warning);
  if (firstResult.status === "rendered" || options.writer === undefined)
    return firstResult;

  let compressed: Memory | undefined;
  try {
    compressed = await compressedMemory(
      memory,
      taskContext,
      options.writer,
      summaryBudget,
    );
  } catch {
    return firstResult;
  }
  if (compressed === undefined) return firstResult;
  const second = contentFor(compressed, recent, taskContext);
  const secondWarning =
    tokenizer.count(second.topics).tokens >
    summaryBudget * (budget.warningThreshold ?? DEFAULT_WARNING_THRESHOLD);
  return budgetResult(second.content, budget, tokenizer, secondWarning);
};
