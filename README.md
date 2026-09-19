# Peaks

An MVP dynamic topic compactor. It reads a conversation as it happens and maintains a separate, topic-organized summary of it, backed by an append-only source archive and audit journal. It never modifies the conversation it reads.

The tracked design is [docs/topic-compactor-spec.md](docs/topic-compactor-spec.md). Project conventions and toolchain decisions are recorded in [CLAUDE.md](CLAUDE.md). Replay, threshold sweeps, and report metrics are covered in [docs/evaluation.md](docs/evaluation.md); the Jev classifier's verified provider facts and question templates are in [docs/jev-adapter.md](docs/jev-adapter.md). The Claude Code Stop hook that keeps a summary of each session in the project's `peaks/` directory is described in [docs/claude-code-hook.md](docs/claude-code-hook.md).

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
| `WRITER_PROVIDER` | `openai` | `openai`, `anthropic`, or `openrouter` (chat completions, routed only to endpoints that support structured output) |
| `WRITER_MODEL` | required | For OpenRouter, a `vendor/model` slug that supports structured outputs |
| `WRITER_API_KEY` | falls back to `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` | |
| `WRITER_ENDPOINT` | provider default | |
| `WRITER_DEADLINE_MS` | `30000` | |
| `WRITER_MAX_INPUT_TOKENS` | `32000` | |
| `EVALUATOR_PROVIDER`, `EVALUATOR_MODEL`, `EVALUATOR_API_KEY` | the writer's values | Model and key are required when the evaluator uses a different provider |
| `EVALUATOR_ENDPOINT`, `EVALUATOR_DEADLINE_MS`, `EVALUATOR_MAX_INPUT_TOKENS` | as for the writer | |
| `AUDIT_DEADLINE_MS` | `2000` | Inline active-mode bypass audit |
| `SHADOW_COMPARISON_DEADLINE_MS` | `2000` | Shadow semantic comparison |

`WRITER_PROMPT_VERSION` and `EVALUATOR_PROMPT_VERSION` may be set only to the versions compiled into the code; they exist so a deployment can assert the prompt it expects.

## Ingestion

Production ingestion must provide a summary budget: `maxTokens` bounds the whole rendered summary (protected records plus topic summaries), and `summaryBudgetTokens` bounds its topic section.

```ts
const pipeline = new CompactPipeline({
  store,
  classifier,
  writer,
  evaluator,
  classifierPolicy,
  executionPolicy, // defaults to shadow
  budget: {
    maxTokens: 6_000,
    summaryBudgetTokens: 4_000,
    tokenizer: readerModelTokenizer,
  },
});
```

The pipeline starts in shadow mode: the writer assesses every chunk and its validated patch is committed, while classifier routing is only recorded. `executionPolicy.mode: "active"` lets the classifier bypass the writer, with sampled bypass audits at `bypassAuditRate`. The separate pipeline option `mode: "baseline"` is the always-writer comparison that skips classification. The evaluator is optional; without it, shadow comparisons and audits record no semantic verdict.

After each commit, `renderSummary(memory, budget)` renders the summary: active protected records, then topic summaries with unresolved issues and source provenance. Ingest counts that same rendering, so it rejects or compresses an over-budget candidate before the atomic memory/processed-marker commit. Render-time compression is an ephemeral display facility and never changes authoritative memory.
