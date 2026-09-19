import { applyPatch } from "../compact/apply_patch";
import { validateCompressionPatch } from "../compact/validate_patch";
import type {
  Memory,
  RenderResult,
  TaskContext,
  TokenBudget,
  Tokenizer,
  Writer,
} from "../schema";
import { budgetResult } from "./budget";
import { assembleSummary } from "./context";
import { ConservativeTokenizer } from "./estimate_tokens";

export const DEFAULT_SUMMARY_TOKEN_BUDGET = 4_000;
export const DEFAULT_WARNING_THRESHOLD = 0.8;

export type RenderOptions = {
  taskContext?: TaskContext;
  tokenizer?: Tokenizer;
  writer?: Writer;
  summaryBudgetTokens?: number;
};

const compressedMemory = async (
  memory: Memory,
  taskContext: TaskContext,
  writer: Writer,
  maxSummaryTokens: number,
): Promise<Memory | undefined> => {
  const candidate = validateCompressionPatch(
    memory,
    await writer.compress({
      memory: structuredClone(memory),
      taskContext,
      maxSummaryTokens,
    }),
  );
  if (!candidate.ok) return undefined;
  return applyPatch(memory, candidate.value);
};

/** Spec §6: render committed memory as the conversation summary. */
export const renderSummary = async (
  memory: Memory,
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
  const first = assembleSummary(memory, tokenizer);
  const warning =
    first.summaryTokens >
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
  const second = assembleSummary(compressed, tokenizer);
  const secondWarning =
    second.summaryTokens >
    summaryBudget * (budget.warningThreshold ?? DEFAULT_WARNING_THRESHOLD);
  return budgetResult(second.content, budget, tokenizer, secondWarning);
};
