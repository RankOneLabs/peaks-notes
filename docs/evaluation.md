# Replay evaluation

The fixture manifest declares two development directories and one held-out directory. Threshold tuning accepts only a directory declared under `dev`; it rejects `fixtures/held_out` so held-out labels cannot influence policy selection. The complete set contains 28 hand-labeled cases and maps every required case from specification §8 to at least one fixture.

Run deterministic acceptance fixtures with recorded stub responses:

```sh
bun run replay --fixtures fixtures/deterministic --adapters stub
```

`recorded` is currently an explicit offline alias for `stub`: both consume the fixture's checked-in adapter response queues without network access. It reserves the mode name for a future standalone trace format; it does not yet load a different transcript schema. `live` constructs the configured Jev, writer, and evaluator adapters from the environment described in the README's configuration table, and never asserts fixture expectations. An archived journal uses a JSON object with `entries`, `labels`, and an optional `policy`:

```sh
bun run replay --journal traces/run.json --adapters recorded --report metrics.json
```

`--manifest <path>` replaces the default `fixtures/manifest.json`. Replay reads existing audit records as the authoritative sample assignments. Programmatic reruns can pass those assignments back through `recordedAuditAssignments`; they are not redrawn from a changed rate or seed.

## Threshold sweep

Sweep all three `ClassifierPolicy` thresholds on development fixtures and write the promotion record:

```sh
bun run sweep --fixtures fixtures/semantic --adapters stub --policy-record fixtures/sweep-record.json
```

The sweep minimizes protected/critical losses and false no-updates first, then maximizes relevance recall, precision, and potential savings. Explicit active replay is refused until the policy record exists:

```sh
bun run replay --fixtures fixtures/semantic --adapters stub --mode active --policy-record fixtures/sweep-record.json
```

Fixture expectations are asserted whenever the effective mode, execution policy, and classifier policy equal the ones the fixture was authored with; the final `Expectations:` line reports how many were asserted and names the ones skipped. A swept policy that differs from the authored thresholds therefore skips assertions, because the authored outcome no longer applies. `--mode baseline` skips every fixture for the same reason: none is authored for the always-writer baseline.

Never use `fixtures/held_out` in a sweep or other tuning command. Evaluate it only after choosing and recording the policy.

The sweep-record gate applies when the CLI explicitly requests `--mode active`. Fixtures may declare `executionPolicy.mode: "active"` and run as authored without a sweep record; this exception is limited to deterministic harness cases that exercise active routing and audit behavior.

## Reading the report

Relevance recall is the primary routing metric; precision and selected topics per chunk expose its cost. False no-updates are reported over all labeled required changes and over bypasses, with separate relevance, same-info, and uncovered-content gate counts. New-versus-changing confusion is separate because either verdict still invokes the writer.

Semantic counts distinguish equivalence, source-supported required updates, writer regressions, and inconclusive comparisons. Inconclusive results are excluded from both agreement and confirmed-miss denominators. The spot-check list includes labeled equivalent and material verdicts.

Audit totals count active-mode bypasses only: eligible, sampled, completed, failed, and timed-out decisions plus the mean configured sampling probability. Shadow would-be bypasses are never sampled and appear separately as `shadow-predictions`. Inline audits run under `AUDIT_DEADLINE_MS` and shadow comparisons under `SHADOW_COMPARISON_DEADLINE_MS` (both default 2000, deliberately far below the writer deadline); slow chunks time out first, so a high timed-out share biases the miss estimate low. Shadow savings are potential writer calls only; active savings subtract sampled audit writer calls. Token and latency totals are split among classifier, writer, and evaluator. Jev cost uses the documented input-only rate of $0.042 per million tokens; writer and evaluator token counts remain separate because their provider prices are deployment configuration.
