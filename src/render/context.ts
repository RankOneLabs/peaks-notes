import type { Memory, Message, TaskContext, Tokenizer } from "../schema";
import { recentWindow } from "./recent_window";
import {
  renderProtectedSection,
  renderRecentSection,
  renderTaskSection,
  renderTopicsSection,
} from "./sections";

export type RawContext = {
  messages: readonly Message[];
  retainedFailures?: readonly Message[];
  recentMessageCount?: number;
};

export type AssembledContext = {
  content: string;
  topics: string;
  totalTokens: number;
  summaryTokens: number;
  nonSummaryTokens: number;
};

export const collectRawContext = (raw: RawContext): Message[] => {
  const window = recentWindow(raw.messages, raw.recentMessageCount);
  const ids = new Set(window.map(({ id }) => id));
  return [
    ...structuredClone([...(raw.retainedFailures ?? [])]).filter(
      ({ id }) => !ids.has(id),
    ),
    ...window,
  ];
};

/** The single authoritative assembly/counting path used by ingest and render. */
export const assembleContext = (
  memory: Memory,
  raw: RawContext,
  taskContext: TaskContext,
  tokenizer: Tokenizer,
): AssembledContext => {
  const recent = collectRawContext(raw);
  const task = renderTaskSection(taskContext);
  const protectedContent = renderProtectedSection(memory);
  const topics = renderTopicsSection(memory);
  const recentContent = renderRecentSection(recent);
  const content = [task, protectedContent, topics, recentContent].join("\n\n");
  const nonSummary = [task, protectedContent, recentContent].join("\n\n");
  return {
    content,
    topics,
    totalTokens: tokenizer.count(content).tokens,
    summaryTokens: tokenizer.count(topics).tokens,
    nonSummaryTokens: tokenizer.count(nonSummary).tokens,
  };
};
