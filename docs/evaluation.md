# Replay evaluation

The fixture manifest declares two development directories and one held-out directory. Threshold tuning accepts only a directory declared under `dev`; it rejects `fixtures/held_out` so held-out labels cannot influence policy selection. The complete set contains 26 hand-labeled cases and maps every required case from specification §8 to at least one fixture.

Run deterministic acceptance fixtures with recorded stub responses:

```sh
bun run replay --fixtures fixtures/deterministic --adapters stub
```

`recorded` consumes the same checked-in adapter transcripts without network access. `live` constructs the configured Jev, writer, and evaluator adapters from the environment described in `docs/jev-adapter.md`. An archived journal uses a JSON object with `entries`, `labels`, and an optional `policy`:

```sh
bun run replay --journal traces/run.json --adapters recorded --report metrics.json
```

Replay reads existing audit records as the authoritative sample assignments. Programmatic reruns can pass those assignments back through `recordedAuditAssignments`; they are not redrawn from a changed rate or seed.

## Threshold sweep

Sweep all three `ClassifierPolicy` thresholds on development fixtures and write the promotion record:

```sh
bun run sweep --fixtures fixtures/semantic --adapters stub --policy-record fixtures/sweep-record.json
```

The sweep minimizes protected/critical losses and false no-updates first, then maximizes relevance recall, precision, and potential savings. Explicit active replay is refused until the policy record exists:

```sh
bun run replay --fixtures fixtures/semantic --adapters stub --mode active --policy-record fixtures/sweep-record.json
```

Never use `fixtures/held_out` in a sweep or other tuning command. Evaluate it only after choosing and recording the policy.

## Reading the report

Relevance recall is the primary routing metric; precision and selected topics per chunk expose its cost. False no-updates are reported over all labeled required changes and over bypasses, with separate relevance, same-info, and uncovered-content gate counts. New-versus-changing confusion is separate because either verdict still invokes the writer.

Semantic counts distinguish equivalence, source-supported required updates, writer regressions, and inconclusive comparisons. Inconclusive results are excluded from both agreement and confirmed-miss denominators. The spot-check list includes labeled equivalent and material verdicts.

Audit totals show eligible, sampled, completed, and failed decisions plus the mean configured sampling probability. Shadow savings are potential writer calls only; active savings subtract sampled audit writer calls. Token and latency totals are split among classifier, writer, and evaluator. Jev cost uses the documented input-only rate of $0.042 per million tokens; writer and evaluator token counts remain separate because their provider prices are deployment configuration.
