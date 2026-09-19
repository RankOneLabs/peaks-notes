import type { RenderResult, TokenBudget, Tokenizer } from "../schema";

export const budgetResult = (
  content: string,
  budget: TokenBudget,
  tokenizer: Tokenizer,
  warning: boolean,
): RenderResult => {
  const required = tokenizer.count(content).tokens;
  return required > budget.maxTokens
    ? { status: "budget_exceeded", budget: budget.maxTokens, required }
    : { status: "rendered", content, tokens: required, warning };
};
