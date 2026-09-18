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

These facts support two sequential logical passes in the v0.4 spec: independent Score questions for per-topic relevance, followed by independent Choice questions for selected-topic relationships and global uncovered content. Whether a future provider request can batch all questions in one call is an adapter concern and must not collapse those logical passes.

## Pages checked

- [TypeSafe Score primitive](https://docs.typesafe.ai/primitives/score) — official request and response shape, 2–10 zero-indexed ordered levels, probability-weighted score, probabilities, and confidence.
- [TypeSafe Noul primitive](https://docs.typesafe.ai/primitives/noul) — official yes-probability response and explicit confirmation that Noul has no separate confidence field.
- [TypeSafe confidence](https://docs.typesafe.ai/confidence) — official distinction between Choice/Score confidence and Noul probability.
- [JevAI Playground documentation](https://www.jevai.org/docs) — request fields, shared state, Choice/Score/Noul criteria and response shapes.
- [JevAI Decision Playground](https://www.jevai.org/playground) — live request preview and the statement that questions share state and are answered independently.
- [TypeSafe AI: Introducing System One Models and Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev) — provider description of Jev as unstructured state in and typed probabilistic decisions out.
- [TypeSafe AI home](https://typesafe.ai/) — provider description of typed decisions with probabilities and confidence, with application-owned action/escalation thresholds.

The official TypeSafe pages are the primary source for primitive semantics. The JevAI community pages are secondary evidence for a current playground contract, not a guarantee that a future production account uses the same endpoint or model identifier. Re-verify the authenticated TypeSafe API documentation when the Jev adapter is implemented.
