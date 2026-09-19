import type { Memory, Message, TaskContext } from "../schema";

export const SECTION_HEADINGS = {
  task: "## Current task and compaction instructions",
  protected: "## Active protected records",
  topics: "## Topic summaries",
  recent: "## Recent raw and retained content",
} as const;

const sourceIds = (sources: Array<{ messageId: string }>): string =>
  sources.map(({ messageId }) => messageId).join(", ") || "none";

export const renderTaskSection = (task: TaskContext): string =>
  [
    SECTION_HEADINGS.task,
    `Current task: ${task.currentTask || "(not supplied)"}`,
    "Instructions:",
    ...(task.compactionInstructions.length === 0
      ? ["- (none)"]
      : task.compactionInstructions.map((instruction) => `- ${instruction}`)),
  ].join("\n");

export const renderProtectedSection = (memory: Memory): string =>
  [
    SECTION_HEADINGS.protected,
    ...memory.protected
      .filter(({ status }) => status === "active")
      .map(
        (record) =>
          `- [${record.kind}] ${record.text} (sources: ${sourceIds(record.sources)})`,
      ),
  ].join("\n");

export const renderTopicsSection = (memory: Memory): string =>
  [
    SECTION_HEADINGS.topics,
    ...memory.topics.flatMap((topic) => [
      `### ${topic.title} [${topic.id}] v${topic.version}`,
      topic.summary,
      `Sources: ${sourceIds(topic.sources)}`,
      ...(topic.unresolved.length === 0
        ? []
        : ["Unresolved:", ...topic.unresolved.map((item) => `- ${item}`)]),
    ]),
  ].join("\n");

export const renderRecentSection = (messages: readonly Message[]): string =>
  [
    SECTION_HEADINGS.recent,
    ...messages.map((item) => {
      if ("toolCall" in item) {
        return `[${item.id}] assistant tool-call ${item.toolCall.name} (${item.toolCall.id}): ${item.content} ${JSON.stringify(item.toolCall.arguments)}`;
      }
      if ("toolResult" in item) {
        return `[${item.id}] tool result (${item.toolResult.callId}): ${item.content}`;
      }
      return `[${item.id}] ${item.role}: ${item.content}`;
    }),
  ].join("\n");
