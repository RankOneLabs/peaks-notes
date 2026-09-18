# Project conventions

These are explicit precedents for reviewer confirmation or amendment before later cohorts build behavior on them.

- **Toolchain:** Use one strict TypeScript package on Bun, with `bun:sqlite`, `bun test`, Zod validation, and Biome formatting/linting. This follows the sibling-project precedent and keeps the MVP small.
- **Tracked specification:** Keep the v0.4 source of truth at `docs/topic-compactor-spec.md`, while `comms/` remains ignored as scratch space. Versioned types can therefore cite their source sections.
- **Jev notes:** Keep verified provider facts and their documentation sources in `docs/jev-adapter.md`. Provider wire formats stay outside the core contracts.
- **Topic identity:** Assign opaque `TopicId` values in code; never derive them from titles, and treat §9 identifiers as fixture labels. Titles can change or collide without changing identity.
- **Journal model:** Define `JournalEntry` as a discriminated union, with `audit_record` and `semantic_comparison` distinct from `committed_update`. Evaluation-only records cannot be mistaken for commits.
- **Errors and idempotency:** Store methods return local `Result` values, and `try`/`catch` surrounds only `bun:sqlite` calls. Enforce replayed-chunk idempotency inside the transaction to close retry races.
- **Memory persistence:** Store one JSON memory document with a revision column and retain history in the append-only journal. Whole-document optimistic updates match the MVP access pattern.
- **Model roles and chunks:** Use separate Classifier, Writer, and Evaluator roles; compression is `Writer.compress`. The host forms chunks, while the core validates complete chunks including tool call/result pairing.

## Commands

- Install: `bun install`
- Typecheck: `bun run typecheck`
- Lint and format check: `bun run lint`
- Test: `bun test`

Use explicit `.js`-free TypeScript imports under Bun's bundler resolution. Export public contracts through `src/schema/index.ts` and the package entry point. Add runtime Zod schemas for every value that crosses an I/O boundary.
