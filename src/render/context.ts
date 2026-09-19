import type { Memory, Tokenizer } from "../schema";
import { renderProtectedSection, renderTopicsSection } from "./sections";

export type AssembledSummary = {
  content: string;
  topics: string;
  totalTokens: number;
  summaryTokens: number;
  protectedTokens: number;
};

/** The single authoritative assembly/counting path used by ingest and render. */
export const assembleSummary = (
  memory: Memory,
  tokenizer: Tokenizer,
): AssembledSummary => {
  const protectedContent = renderProtectedSection(memory);
  const topics = renderTopicsSection(memory);
  const content = [protectedContent, topics].join("\n\n");
  return {
    content,
    topics,
    totalTokens: tokenizer.count(content).tokens,
    summaryTokens: tokenizer.count(topics).tokens,
    protectedTokens: tokenizer.count(protectedContent).tokens,
  };
};
