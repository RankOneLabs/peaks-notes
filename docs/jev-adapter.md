# Jev adapter facts for the live conversation summarizer

Verified 18 September 2026. This document records the provider facts behind the adapter in `src/classifier/jev/`. The wire payload stays inside that adapter; the core schema does not expose it.

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

The shared state contains the trusted current task and compaction instructions, followed by the complete chunk inside `<transcript-data>` delimiters. Relationship state also contains protected records inside `<protected-records-data>` delimiters. Transcript text is data, never model instruction text. Every value placed inside a data delimiter is JSON-serialized with `<` escaped as `\u003c`, so quoted content cannot close its delimiter.

Each relevance question is keyed by the topic ID, opens with a `Template version: relevance-v3` line, and uses:

> Does any meaningful part of the transcript chunk relate to this topic? Score relevance strength, including brief corrections, rather than the fraction of the chunk devoted to it. Acknowledgment, praise, emotion, a requested recap, or an unchanged preference is not meaningful by itself.

It then includes `Topic id`, `Topic title`, and `Routing description`. The Noul true criterion is “At least one meaningful fact, correction, constraint, or status update relates to this topic.” The false criterion explicitly includes acknowledgments, requested recaps, and unchanged preferences that add no durable information.

Each selected-topic relationship question is keyed by topic ID, contains the topic's ID and title plus its complete summary inside `<full-topic-summary-data>` delimiters, and uses:

> Classify how the transcript relates to the selected topic. Judge information gain against the complete existing summary, not conversational engagement. If it both adds and changes information, choose changing_info.

Its criteria are `new_info`, `changing_info`, and `no_meaningful_addition`, using the definitions in specification §5C. `no_meaningful_addition` covers both substantive information already represented in memory and conversational references such as requested recaps, acknowledgments, reactions, closure, and unchanged preferences. This single no-write choice avoids dividing probability between equivalent routing outcomes. The core schema continues accepting the legacy `same_info` value when replaying older journals and fixtures, but the live adapter does not offer it in new questions. The versioned `relationship-v6` `uncovered` question contains every selected topic's stable ID, title, complete summary, and unresolved issues inside `<selected-topic-evidence-data>`, then the complete topic catalog inside `<complete-topic-catalog-data>`. Its `transient` outcome explicitly covers praise, thanks, emotion, and conversational closure with no new durable information. The ID `uncovered` is reserved; a topic with that ID is rejected. An empty selection is represented by an empty JSON array. It uses:

> Classify any meaningful transcript content not covered by the selected topics. Content related to an unselected catalog topic is a routing miss and must be uncertain, never none. Use the complete catalog only to distinguish a genuinely new topic from a routing miss.

Its criteria are `none`, `new_topic`, `transient`, and `uncertain`.

Questions are split across requests at the 32,000 input-token bound while retaining the shared state in every request; no question is omitted. The uncovered question is independently sufficient even when it is alone in a request. Shared state or an individual state-plus-question that cannot fit returns `incomplete_input`, so selected evidence is never truncated to authorize a bypass. Relevance and relationship questions are never combined. HTTP 429 and 529 responses use exponential backoff within the configured call deadline.

Every request of both passes is kept as a call trace carrying the provider (`typesafe`), model, template version, per-request usage and status, and the full answer distributions. Ingest validates drained traces and journals them as classifier model calls. Bump the template version whenever a template or its serialization changes, so journaled decisions stay attributable to the prompt that produced them.

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

The official TypeSafe pages are the primary source for primitive semantics. The JevAI community pages are secondary evidence for a current playground contract, not a guarantee that a production account uses the same endpoint or model identifier. Re-verify against the authenticated TypeSafe API documentation before relying on live results; `JEV_ENDPOINT` overrides the endpoint without a code change.
