import type { TokenCount, Tokenizer } from "../schema";

/**
 * Conservative UTF-8 fallback: at least one token per three bytes, plus one
 * token per whitespace-delimited unit. The larger estimate is used.
 */
export const estimateTokens = (text: string): number => {
  if (text.length === 0) return 0;
  const bytes = new TextEncoder().encode(text).length;
  const words = text.trim() === "" ? 0 : text.trim().split(/\s+/u).length;
  return Math.max(words, Math.ceil(bytes / 3));
};

export class ConservativeTokenizer implements Tokenizer {
  count(text: string): TokenCount {
    return { tokens: estimateTokens(text), method: "conservative_estimate" };
  }
}
