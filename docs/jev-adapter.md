# Jev adapter facts for the topic compactor

Verified 18 September 2026. This document records provider facts needed by a later adapter cohort; it does not implement or freeze a Jev wire payload in the core schema.

## Verified facts

- Jev consumes shared state plus a map of typed questions and returns structured decisions rather than generated prose.
- The documented question primitives are Choice, Score, and Noul. Choice selects among named criteria, Score uses an ordered rubric, and Noul returns a yes probability.
- Questions in a request share the same state. Answer values are keyed by the caller's question IDs.
- A Score rubric has 2–10 ordered levels numbered from zero. Its numeric result is a probability-weighted position on that rubric, so it is not inherently a calibrated probability.
- A Choice result includes the selected choice, option probabilities, and confidence. A Noul result is itself the probability of yes and has no separate confidence field.
- Typed output guarantees the response shape, not factual correctness. The core must validate IDs, numeric ranges, completeness, and policy thresholds and must escalate incomplete responses.
- Provider model names, limits, credentials, retry behavior, and request/response normalization belong inside the adapter. The classifier contracts in `src/schema/` deliberately do not expose them.

The implemented adapter uses Noul (rather than Score) for relevance, so its value is directly the probability of “yes.” It preserves two sequential logical passes: Noul questions for per-topic relevance, followed by Choice questions for selected-topic relationships and global uncovered content. Requests use `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer`, and the pinned model `jev-1.13.0`.

## Exact question templates

The shared state contains the trusted current task and compaction instructions, followed by the complete chunk inside `<transcript-data>` delimiters. Relationship state also contains protected records inside `<protected-records-data>` delimiters. Transcript text is data, never model instruction text.

Each relevance question is keyed by the topic ID and uses:

> Does any meaningful part of the transcript chunk relate to this topic? Score relevance strength, including brief corrections, rather than the fraction of the chunk devoted to it.

It then includes `Topic id`, `Topic title`, and `Routing description`. The Noul true criterion is “At least one meaningful fact, correction, constraint, or status update relates to this topic.” The false criterion is “No meaningful part relates to this topic.”

Each selected-topic relationship question is keyed by topic ID, contains that topic's complete summary, and uses:

> Classify how the transcript relates to the selected topic. If it both adds and changes information, choose changing_info.

Its criteria are `new_info`, `changing_info`, and `same_info`, using the definitions in specification §5C. The `uncovered` question contains the complete topic catalog and uses:

> Classify any meaningful transcript content not covered by the selected topics, using the complete catalog to distinguish a new topic from a routing miss.

Its criteria are `none`, `new_topic`, `transient`, and `uncertain`.

Questions are split across requests at the 32,000 input-token bound while retaining the shared state in every request; no question is omitted. Shared state or an individual state-plus-question that cannot fit returns `incomplete_input`. Relevance and relationship questions are never combined. HTTP 429 and 529 responses use exponential backoff within the configured call deadline.

## Cost accounting

The adapter uses an input rate of **$0.042 per million tokens** (`$42` per billion input tokens); output tokens are free. This is the public Jev rate stated by TypeSafe in [Introducing System One Models and Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) and on the [TypeSafe AI home page](https://typesafe.ai/). The rate was verified on 18 September 2026 and is pinned in code as `JEV_INPUT_COST_PER_MILLION_TOKENS_USD`; update the constant and this note together if provider pricing changes.

## Pages checked

- [TypeSafe Score primitive](https://docs.typesafe.ai/primitives/score) — official request and response shape, 2–10 zero-indexed ordered levels, probability-weighted score, probabilities, and confidence.
- [TypeSafe Noul primitive](https://docs.typesafe.ai/primitives/noul) — official yes-probability response and explicit confirmation that Noul has no separate confidence field.
- [TypeSafe confidence](https://docs.typesafe.ai/confidence) — official distinction between Choice/Score confidence and Noul probability.
- [JevAI Playground documentation](https://www.jevai.org/docs) — request fields, shared state, Choice/Score/Noul criteria and response shapes.
- [JevAI Decision Playground](https://www.jevai.org/playground) — live request preview and the statement that questions share state and are answered independently.
- [TypeSafe AI: Introducing System One Models and Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) — provider description of Jev as unstructured state in and typed probabilistic decisions out.
- [TypeSafe AI home](https://typesafe.ai/) — provider description of typed decisions with probabilities and confidence, with application-owned action/escalation thresholds.

The official TypeSafe pages are the primary source for primitive semantics. The JevAI community pages are secondary evidence for a current playground contract, not a guarantee that a future production account uses the same endpoint or model identifier. Re-verify the authenticated TypeSafe API documentation when the Jev adapter is implemented.
