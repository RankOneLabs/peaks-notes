# Peaks

An MVP dynamic topic compactor that maintains compact, topic-organized conversation memory while preserving an append-only source archive and audit journal.

The tracked design is [docs/topic-compactor-spec.md](docs/topic-compactor-spec.md). Project conventions and toolchain decisions are recorded in [CLAUDE.md](CLAUDE.md).

```sh
bun install
bun run typecheck
bun run lint
bun test
```

Production ingestion must provide a host budget after reserving tokens for system instructions, tools, and the response. `rawMessages` is the exact raw context that will remain after a successful commit, including older retained failures; do not include messages already represented only by topic summaries.

```ts
const pipeline = new CompactPipeline({
  store,
  classifier,
  writer,
  classifierPolicy,
  budget: {
    maxTokens: availableContextTokens,
    summaryBudgetTokens: 4_000,
    tokenizer: targetModelTokenizer,
    rawMessages: recentMessagesAfterCommit,
    retainedFailures,
  },
});
```

Ingest assembles and counts the same task, active protected records, topic summaries, unresolved issues, source provenance, and raw content as `renderContext`. It rejects or compresses an over-budget candidate before the atomic memory/processed-marker commit. Render-time compression remains an ephemeral display facility and never changes authoritative memory.
