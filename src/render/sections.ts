import type { Memory } from "../schema";

export const SECTION_HEADINGS = {
  protected: "## Active protected records",
  topics: "## Topic summaries",
} as const;

const sourceIds = (sources: Array<{ messageId: string }>): string =>
  sources.map(({ messageId }) => messageId).join(", ") || "none";

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
