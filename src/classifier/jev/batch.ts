import { estimateModelTokens } from "../../writer/provider";
import type { JevQuestion, JevRequest } from "./wire";
import { JEV_MODEL } from "./wire";

export class IncompleteInputError extends Error {
  readonly code = "incomplete_input" as const;
  constructor(
    message: string,
    readonly inputTokens: number,
  ) {
    super(message);
    this.name = "IncompleteInputError";
  }
}

const size = (value: unknown): number =>
  estimateModelTokens(JSON.stringify(value));

export const batchJevQuestions = (
  state: string,
  questions: Record<string, JevQuestion>,
  maxInputTokens = 32_000,
  contextTokens = 64_000,
): JevRequest[] => {
  const stateTokens = estimateModelTokens(state);
  if (stateTokens >= maxInputTokens) {
    throw new IncompleteInputError(
      `shared state alone is ${stateTokens} tokens and exceeds the ${maxInputTokens} token input limit`,
      stateTokens,
    );
  }
  const requestLimit = Math.min(maxInputTokens, contextTokens - 1);
  const batches: JevRequest[] = [];
  let current: Record<string, JevQuestion> = {};
  for (const [id, question] of Object.entries(questions)) {
    const alone = { model: JEV_MODEL, state, questions: { [id]: question } };
    const aloneTokens = size(alone);
    if (aloneTokens > requestLimit) {
      throw new IncompleteInputError(
        `state plus question ${id} is ${aloneTokens} tokens and exceeds the ${requestLimit} token input limit`,
        aloneTokens,
      );
    }
    const candidate = { ...current, [id]: question };
    if (
      Object.keys(current).length > 0 &&
      size({ model: JEV_MODEL, state, questions: candidate }) > requestLimit
    ) {
      batches.push({ model: JEV_MODEL, state, questions: current });
      current = { [id]: question };
    } else {
      current = candidate;
    }
  }
  if (Object.keys(current).length > 0)
    batches.push({ model: JEV_MODEL, state, questions: current });
  return batches;
};
