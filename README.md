# Peaks

An MVP dynamic topic compactor that maintains compact, topic-organized conversation memory while preserving an append-only source archive and audit journal.

The tracked design is [docs/topic-compactor-spec.md](docs/topic-compactor-spec.md). Project conventions and toolchain decisions are recorded in [CLAUDE.md](CLAUDE.md). Replay, threshold sweeps, and report metrics are covered in [docs/evaluation.md](docs/evaluation.md); the Jev classifier's verified provider facts and question templates are in [docs/jev-adapter.md](docs/jev-adapter.md).

```sh
bun install
bun run typecheck
bun run lint
bun test
bun run replay --fixtures fixtures/deterministic --adapters stub
```

## Configuration

Stub and recorded replays need no configuration. Live adapters read the environment once at startup through `loadConfig`; credentials never enter prompts, fixtures, or journals.

| Variable | Default | Purpose |
| --- | --- | --- |
| `JEV_BEARER_KEY` | required | System One bearer key |
| `JEV_MODEL` | `jev-1.13.0` | Pinned; any other value is rejected |
| `JEV_ENDPOINT` | `https://api.typesafe.ai/v1/systemone` | |
| `JEV_DEADLINE_MS` | `30000` | Per Jev request, including retries |
| `JEV_MAX_INPUT_TOKENS` / `JEV_CONTEXT_TOKENS` | `32000` / `64000` | Request batching bounds |
| `WRITER_PROVIDER` | `openai` | `openai` or `anthropic` |
| `WRITER_MODEL` | required | |
| `WRITER_API_KEY` | falls back to `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | |
| `WRITER_ENDPOINT` | provider default | |
| `WRITER_DEADLINE_MS` | `30000` | |
| `WRITER_MAX_INPUT_TOKENS` | `32000` | |
| `EVALUATOR_PROVIDER`, `EVALUATOR_MODEL`, `EVALUATOR_API_KEY` | the writer's values | Model and key are required when the evaluator uses a different provider |
| `EVALUATOR_ENDPOINT`, `EVALUATOR_DEADLINE_MS`, `EVALUATOR_MAX_INPUT_TOKENS` | as for the writer | |
| `AUDIT_DEADLINE_MS` | `2000` | Inline active-mode bypass audit |
| `SHADOW_COMPARISON_DEADLINE_MS` | `2000` | Shadow semantic comparison |

`WRITER_PROMPT_VERSION` and `EVALUATOR_PROMPT_VERSION` may be set only to the versions compiled into the code; they exist so a deployment can assert the prompt it expects.

## Ingestion

Production ingestion must provide a host budget after reserving tokens for system instructions, tools, and the response. `rawMessages` is the exact raw context that will remain after a successful commit, including older retained failures; do not include messages already represented only by topic summaries.

```ts
const pipeline = new CompactPipeline({
  store,
  classifier,
  writer,
  evaluator,
  classifierPolicy,
  executionPolicy, // defaults to shadow
  budget: {
    maxTokens: availableContextTokens,
    summaryBudgetTokens: 4_000,
    tokenizer: targetModelTokenizer,
    rawMessages: recentMessagesAfterCommit,
    retainedFailures,
  },
});
```

The pipeline starts in shadow mode: the writer assesses every chunk and its validated patch is committed, while classifier routing is only recorded. `executionPolicy.mode: "active"` lets the classifier bypass the writer, with sampled bypass audits at `bypassAuditRate`. The separate pipeline option `mode: "baseline"` is the always-writer comparison that skips classification. The evaluator is optional; without it, shadow comparisons and audits record no semantic verdict.

Ingest assembles and counts the same task, active protected records, topic summaries, unresolved issues, source provenance, and raw content as `renderContext`. It rejects or compresses an over-budget candidate before the atomic memory/processed-marker commit. Render-time compression remains an ephemeral display facility and never changes authoritative memory.
