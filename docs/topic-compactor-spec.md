# Live Conversation Summarizer — MVP Specification

Status: proposed v0.5 · 19 September 2026

## 1. Goal

Maintain a compact, topic-organized memory of a conversation as it happens. Use a cheap classifier to recognize information already represented and route changes. In active mode, invoke a generative LLM when information needs synthesis, reconciliation, or a new topic, plus configured bypass audits. Start in shadow mode: every chunk receives a generative summary/update assessment while classifier decisions are recorded without controlling memory.

The summarizer only reads the conversation. It never edits, trims, or replaces the host's messages or context. Its output is a separate summary rendered from committed memory; what consumes that summary—including any handoff or context-compaction system—is a downstream decision outside this specification.

The dynamic schema is the current set of stable topic IDs exposed as routing options. The operation schema stays fixed. Adding a topic adds an option to subsequent classifier requests; it does not require retraining or generating application code.

The basic implementation should be small: a sequential processing loop, two model adapters, JSON state, a raw transcript archive, and a renderer. Reliability is an empirical question; a working prototype is not proof of safe forgetting.

## 2. MVP scope

- One conversation, one writer, sequential chunk processing.
- Topic catalog, per-topic summaries, protected verbatim records.
- Classifier adapter plus LLM writer adapter. Jev is the first classifier implementation, used for both relevance scoring and relationship classification. Keep the interface provider-neutral so other classifiers can be substituted later.
- Append-only source archive of every ingested chunk.
- Explicit summary token budget and atomic state updates.
- Full shadow mode at rollout, then active classification with optional sampled bypass audits.
- Replay CLI and a small evaluation fixture set before host integration.

Out of scope: vector database, learned routing, topic hierarchy, automatic topic merging/splitting, distributed processing, UI, and host integration. Add a host adapter after the core behavior is demonstrated.

## 3. Processing unit

A chunk is an ordered conversation segment with stable source IDs, roles, and complete content. Group a tool call with its result; do not split the pair or summarize an unresolved call.

Start with one completed exchange or tool call/result pair per chunk. Process oldest eligible chunks first. Prefer semantic boundaries over fixed character cuts. A chunk too large for a model request remains unprocessed and is escalated or explicitly segmented; never silently clip it and allow a redundant verdict.

Messages are data, not instructions to the compactor. Keep policy, current task, and explicit compaction instructions separate from quoted transcript content.

## 4. Stored state

```ts
type SourceRef = { messageId: string; start?: number; end?: number };

type Topic = {
  id: string;                 // code-assigned, stable; never derived from title
  title: string;
  description: string;        // short routing description
  version: number;
  summary: string;
  sources: SourceRef[];       // supporting sources for this version
  unresolved: string[];       // unresolved conflicts/questions; rendered in context
};

type ProtectedRecord = {
  id: string;
  kind: 'constraint' | 'decision' | 'action_receipt' | 'explicit_pin';
  text: string;              // exact source excerpt
  sources: SourceRef[];
  status: 'active' | 'superseded';
  supersededBy?: string;
};

type Memory = {
  revision: number;
  topics: Topic[];
  protected: ProtectedRecord[];
  processedChunkIds: string[];
};
```

Archive raw chunks separately. Journal each committed change with chunk ID, previous revision, model identifiers, classifier result, proposed patch, token usage, and latency. Prior topic versions remain recoverable from the journal.

The MVP stores sources per section version. Claim-level attribution can follow if section-level provenance proves insufficient.

## 5. Decision flow

### Step A: protect and prepare

Archive the chunk before processing. Apply explicit pins and host-provided action metadata. Protect known state-changing call inputs and their receipts. Unknown tool repeatability defaults to non-repeatable; never assume that a deployment, payment, or external read can simply be repeated.

The host supplies action metadata on each tool call:

```ts
type ToolAction =
  | { effect: 'read_only' }
  | { effect: 'state_changing'; receiptArguments?: string[] };
```

A `read_only` call and its result are not protected; the writer summarizes them like any other content. A `state_changing` call becomes one action receipt citing the call and its result, holding the tool name, the arguments named in `receiptArguments` (every argument when omitted), and the result's error flag; the result content goes to the writer. The host marks a tool read-only only when it knows that repeating the call is safe and its output does not need to stay exact.

The writer may propose additional protected constraints and decisions. This semantic detection is fallible and must be evaluated; only explicit pins and supplied metadata are deterministic guarantees. Without tool metadata, retain unknown tool records verbatim in the MVP.

### Step B: score relevance to every topic

The first Jev pass receives the complete chunk, current task, compaction instructions, and every topic's stable ID, title, and routing description. Generate one independent relevance-score question per topic. Ask: “Does any meaningful part of this chunk relate to this topic?” Score relevance strength, not the fraction of the chunk devoted to the topic: a brief critical correction must still qualify.

```ts
type RelevanceResult = {
  topics: Array<{ topicId: string; score: number }>;
};
type ClassifierPolicy = {
  relevanceThreshold: number;
  sameInfoMinConfidence: number;
  uncoveredNoChangeMinConfidence: number;
};
```

The adapter documents and validates its score scale; code selects every topic whose score is at or above the configured threshold. Scores are relevance signals, not assumed calibrated probabilities. Multiple topics can qualify; do not choose only the highest-scoring topic or silently cap the selected set. Missing scores, invalid values, or unknown IDs cause escalation, never an implicit zero.

Optimize this gate for **recall**. An unnecessary match costs another classification and potentially a writer review; a missed match can hide a correction or addition. Tune the threshold on labeled chunk/topic pairs, report precision and cost alongside recall, and keep a separate held-out set. Do not treat an arbitrary 0.5 as a validated threshold.

With an empty catalog, send the chunk directly to the writer for initial topic creation or an explicit transient-content decision. No matches in a nonempty catalog does not imply irrelevance: the uncovered-content check still runs.

### Step C: classify the relationship for selected topics

The second Jev pass receives the complete chunk and the full current summaries of every selected topic, with the task, compaction instructions, and relevant protected records. Generate one choice question per selected topic:

```ts
type Relationship =
  | 'new_info'
  | 'changing_info'
  | 'same_info'
  | 'no_meaningful_addition';
type Assessment = {
  relations: Array<{
    topicId: string;
    relationship: Relationship;
    confidence: number;
  }>;
  uncovered: {
    outcome: 'none' | 'new_topic' | 'transient' | 'uncertain';
    confidence: number;
  };
};
```

| Choice | Meaning | Action |
| --- | --- | --- |
| new_info | Relevant information extends the section without changing its existing claims | Send section and chunk to writer |
| changing_info | Relevant information corrects, contradicts, qualifies, or supersedes an existing claim | Send section and chunk to writer for reconciliation |
| same_info | Legacy replay value for information already represented; live Jev questions no longer emit it | Treat like `no_meaningful_addition` |
| no_meaningful_addition | The chunk adds no durable information: substantive information is already represented, or it only recaps, acknowledges, reacts, closes, or reaffirms an unchanged preference | No section update, subject to the confidence gate |

If a chunk both adds and changes information within a topic, `changing_info` takes precedence. The writer sees the full chunk and handles both. The live Jev adapter uses one `no_meaningful_addition` choice for both already-represented substantive information and conversational references with no durable information gain. `same_info` remains in the core type only so historical journals and fixtures remain replayable. A low-confidence classification remains an orchestration-level escalation rather than authorizing a bypass.

Treat **same_info and no_meaningful_addition as consequential bypass decisions**. Accept either only above a separately evaluated confidence threshold; otherwise ask the writer to review. Provider confidence is a routing signal, not proof of correctness. New/changing verdicts always reach the writer, which may legitimately conclude that no update is needed. A false-positive match does not force a memory mutation.

Also ask a global uncovered-content question: does any meaningful content remain outside the selected topics, even if other parts matched? Return `none`, `new_topic`, `transient`, or `uncertain`. Include the entire topic catalog so the writer can distinguish a genuinely new topic from a routing miss; if the catalog suggests an existing but unselected topic, escalate to the writer with its full summary rather than blindly creating a duplicate. This check still runs when no topic passes Step B.

A confident `new_topic` routes to the writer for creation or routing repair. `uncertain`, low-confidence `none`/`transient`, or incomplete input routes to writer review. Only sufficiently supported `none`/`transient` permits bypass. Tune this bypass gate for missed novel information as well as cost; novelty can coexist with matches to existing topics.

A chunk gets a no-update decision only when all selected-topic verdicts are confident `same_info` or `no_meaningful_addition`, the uncovered-content check passes its no-change gate, and protected information remains retained. Omitted relationships, invalid responses, or incomplete input never authorize a no-update decision.

These are **two sequential logical passes in the MVP**: score relevance, select in code, then classify relationships. Batch each pass's independent questions where the provider permits. Do not combine the passes by default. If selected summaries exceed the request budget, batch without silently truncating evidence; if the global coverage check cannot inspect enough context, escalate or leave the chunk unprocessed. The adapter owns provider request limits and response normalization. Verify the current Jev wire format when implementing; these TypeScript types describe the core contract, not an asserted API payload.

### Step D: invoke the writer according to execution mode

In active mode, the writer receives the original chunk, affected full sections, catalog, current task, protected records, compaction instructions, and assessment. Shadow mode and bypass audits use an independent writer input as specified below. On uncertain routing it receives all sections if possible; otherwise leave the chunk unprocessed rather than pretend the search was exhaustive.

It returns a structured patch containing replacement summaries for affected topics, new topics, proposed protected records, and unresolved conflicts. Allow one patch to cover multiple topic changes. Include supporting source references and expected topic versions.

Writer rules:

1. Preserve existing relevant facts unless the source supports a change.
2. Separate observations, user instructions, assistant hypotheses, and tool outcomes.
3. Treat recency as chronology, not proof. An explicit user correction can supersede an earlier preference; an unsupported later claim does not establish truth.
4. Preserve uncertainty. If a conflict cannot be resolved from sources, record both positions and the open question.
5. Keep exact IDs, amounts, paths, and constraints when their exact form matters; protected excerpts remain verbatim.
6. Generate no tool actions. This component edits memory only.
7. Update only affected sections and avoid copying the same material into every topic.

### Step E: validate and commit

Code validates the patch schema, source references, allowed topic IDs, expected versions, preservation of explicit pins, and token budget. Assign IDs to new topics in code. Commit the memory update, journal event, and processed-chunk marker atomically.

For no-update decisions, atomically journal the decision and mark the chunk processed. Only a committed chunk counts as summarized. Reprocessing an already committed chunk ID is a no-op.

Schema and reference checks establish structural validity, not semantic fidelity. Invalid output, timeout, unsupported content, or stale versions leave prior memory intact and the chunk unprocessed. Do not silently advance the processed marker.

### Execution modes: full shadow and sampled audits

```ts
type ExecutionPolicy = {
  mode: 'shadow' | 'active';  // default: shadow
  bypassAuditRate: number;   // [0, 1], used only in active mode
  auditSeed: string;         // stable sampling for replay
};
```

**Shadow mode summarizes every chunk.** Run the two Jev passes and record the proposed routing/bypass decision, but always invoke the writer against the same pre-update memory snapshot. The writer's validated patch is authoritative and committed through the usual validation path; classifier decisions do not suppress or restrict the update. “Summarizes everything” means every chunk is assessed for a summary update, not that irrelevant text must be added or every section rewritten. The writer can return an explicit empty patch.

Hide Jev scores, labels, and bypass decisions from the shadow writer to avoid anchoring. Supply the complete chunk, all current topic summaries, task, preservation instructions, and protected records so it can independently discover missed topics. If the full input cannot be inspected within budget, retain/escalate the chunk and label the comparison incomplete; do not count a limited-input result as confirmation. A classifier failure does not block an otherwise valid writer update in shadow mode; log it as unavailable classification. A writer failure follows the usual unprocessed/no-commit behavior.

**Active mode with sampled bypass audits** lets Jev control normal routing. Deterministically sample complete would-be no-update decisions using chunk ID, seed, and configured audit rate. Include same-info bypasses and uncovered-content none/transient bypasses, including zero-match chunks. Rate 1 audits every bypass; rate 0 disables audits. Sampling is an additional writer invocation, not a second committed memory branch.

The audit writer sees the same complete pre-decision snapshot and independent input as the shadow writer. Validate and journal its patch, but discard it from live memory: the active bypass decision remains authoritative. Audit failures are inconclusive, never evidence that skipping was safe. In the MVP, run audits inline before finalizing the bypass journal entry, with a bounded deadline; an audit-only failure does not alter the active policy. Record the sampled decision even if the audit times out. Replays reuse the recorded sample assignment.

Record mode, snapshot revision, chunk ID, classifier and writer versions/prompts, policy thresholds, sampling probability, proposed bypass, audit outcome, patch, and separate classifier/writer token cost and latency. Keep audit patches apart from committed patches. A discovered substantive miss is a review event; explicitly switch back to shadow and replay archived chunks if repair is required. Never silently apply a discarded patch to a newer memory revision.

### Semantic comparison of shadow and audit summaries

A nonempty patch or changed summary string is **not** evidence of a missed update. Generators often reword correct summaries. Evaluate whether the proposed memory is materially different from the pre-update memory, and whether that difference is supported by the source chunk.

Apply the validated writer patch to an isolated copy of the pre-update snapshot. Compare the resulting summaries with the original summaries, including protected records and unresolved issues. Compare meaning across the whole affected set so moving a fact between sections or renaming a topic does not look like new information. For a would-be bypass, the unchanged pre-update snapshot is exactly what the classifier-controlled path would have retained.

Use a separate generative-model comparison call in the initial implementation. It receives before/after memory, the original chunk, source references, task, and preservation instructions—but not Jev's verdict, scores, or the writer's explanation. It is a replaceable evaluator adapter, separate from the Jev classifier and the writer. It may use the same model provider initially; independence of input does not eliminate correlated model errors.

```ts
type SemanticComparison = {
  verdict: 'equivalent' | 'material_change' | 'uncertain';
  changes: Array<{
    kind: 'addition' | 'correction' | 'omission' | 'contradiction';
    before: string | null;
    after: string | null;
    sources: SourceRef[];
    assessment: 'required_update' | 'writer_regression' | 'uncertain';
    reason: string;
  }>;
};
```

Material differences change task-relevant facts, necessary exact values, constraints, commitments, action status, scope, qualifiers, or unresolved uncertainty. Paraphrasing, reordered bullets, formatting, equivalent compression, and moving an unchanged fact between topics are not material. Losing a qualifier during a seemingly cosmetic rewrite is material.

- **Equivalent:** semantic agreement with the bypass, even if every sentence was rewritten.
- **Source-supported required update:** candidate missed update by the classifier; count as a confirmed miss only after the chosen adjudication process.
- **Writer regression:** unsupported addition, distortion, or loss of still-required information; record separately, not as a classifier miss.
- **Uncertain, invalid, or failed comparison:** inconclusive; do not count as agreement or confirmed failure.

A result can contain both a required update and a writer regression. Record both rather than force one label for the entire patch. Require source references and concrete before/after evidence for reported material differences. Human spot checks include both equivalent and material verdicts.

An exactly unchanged memory can skip the comparison call and be logged as writer agreement, still not proof that both models avoided an omission. Semantic comparison is evaluation-only in this MVP: it does not alter the previously specified shadow commit or active audit-discard behavior. Record comparison model/prompt version, outcome, tokens, and latency separately; run comparisons against immutable snapshots even if logging completes after a shadow commit.

Full shadow evaluates decisions on writer-maintained memory; it does not establish the long-run behavior of gated memory. Active replay and sampled audits are still needed to expose accumulated drift.

Start with full shadow enabled. Move to active mode through an explicit configuration change after reviewed traces show acceptable miss risk and useful savings. Lower or disable sampling when the evidence justifies it; a stable observed rate alone is insufficient without adequate sample size and topic coverage. Model, prompt, threshold, or workload changes warrant renewed shadow/audit measurement. There is no automatic promotion or demotion controller in the MVP.

## 6. Summary rendering and budget

Render the summary from committed memory in this order:

1. Active protected records.
2. Topic summaries, including unresolved conflicts and source IDs.

The summary contains memory only. The current task, compaction instructions, and transcript are model inputs, not rendered output.

The host sets two budgets: one for the whole rendered summary and one for its topic section. Count the rendered output with the tokenizer of the model expected to read it where available; use a conservative estimate only as an explicitly measured fallback. Protected records count against the total budget and are never compressed.

Suggested prototype settings: 4,000 tokens for topic summaries and a warning at 80% of that budget. These are starting parameters, not measured optimums.

When an update would exceed budget, make one LLM compression pass over topic summaries, preserving protected records and unresolved issues. Validate again. If it still does not fit, return a typed `budget_exceeded` result without committing; the chunk stays unprocessed and the host can raise the budget or request intervention. Never silently evict protected facts. Global compression is exceptional, not the normal per-chunk path.

Do not create a topic for every incidental observation. The writer creates a section only when the information is relevant to continued work and does not fit an existing section. Stable IDs survive title/description changes. Defer automatic topic merging until actual traces show a need.

## 7. Minimal interfaces and implementation

```ts
interface Classifier {
  scoreRelevance(input: RelevanceInput): Promise<RelevanceResult>;
  classifyRelationships(input: RelationshipInput): Promise<Assessment>;
}
interface Writer {
  propose(input: UpdateInput): Promise<MemoryPatch>;
}
interface Store {
  archive(chunk: Chunk): Promise<void>;
  load(): Promise<Memory>;
  commit(expectedRevision: number, change: Commit): Promise<void>;
}

// Public surface
ingest(chunk, taskContext): Promise<IngestResult>
renderSummary(memory, budget): RenderResult
```

Use a single TypeScript package with runtime schema validation. SQLite is a simple storage option for atomic commits and an append-only journal; a transactional store is an implementation detail, not an agent framework. Model adapters need deadlines and usage reporting. Process one chunk at a time so each decision sees the latest topic state.

Implement `JevClassifier` first, with both methods above. Keep Jev credentials, request schemas, question batching, score normalization, and response parsing inside that adapter. The core applies thresholds and determines escalation; the generative writer is a separate configurable model adapter. No Jev SDK or Claude-specific message shape belongs in the core. Host adapters can later expose the same core through a Claude Code plugin, Oakridge, or a harness using open-weight models.

Suggested modules: `schema`, `store`, `classifier`, `writer`, `compact`, `render`, and `replay`. No planner, agent orchestration, or embedding pipeline is required.

Build order:

1. Define schemas and deterministic state transitions; run fixtures with stub adapters.
2. Add the writer; establish an always-LLM incremental baseline.
3. Implement Jev relevance scoring and relationship choices in full shadow mode: always run and commit the independently assessed writer update, while logging what Jev would have bypassed.
4. Add the semantic before/after comparator, replay metrics, reviewed material disagreements, fault cases, and active-mode sampled bypass audits with discarded audit patches.
5. Integrate a host in shadow mode after deterministic acceptance cases pass; collect real traces before enabling active bypasses through explicit configuration.

The always-LLM baseline uses the same topic state and writer so the effect of classifier routing can be isolated.

## 8. Minimum useful evaluation

Start with roughly 20–30 hand-inspected fixtures plus a few realistic multi-turn traces. Expand around observed failures. Label fixtures independently of model suggestions so the grader is not merely approving a persuasive decision.

Required cases:

| Case | Expected behavior |
| --- | --- |
| Exact restatement or equivalent paraphrase | Active, unaudited: no writer call; shadow/audited: writer assessment; wording changes still count as semantically equivalent |
| Shadow-mode predicted bypass with a substantive writer patch | Writer patch validated and committed; semantic comparison checks whether a required update was missed |
| Active sampled bypass with a substantive audit patch | Audit patch journaled but never committed |
| Writer rewrites wording without changing meaning | Semantic agreement; no classifier miss |
| Writer adds an unsupported claim | Writer regression, not a classifier miss |
| Writer drops a required qualifier | Material writer regression, not cosmetic change |
| Semantic comparator fails or cannot determine equivalence | Inconclusive; excluded from agreement and confirmed-miss counts |
| Audit timeout or invalid response | Inconclusive audit; excluded from agreement count |
| Classifier failure in shadow mode | Independent writer path continues; classification marked unavailable |
| Replay with the same seed and chunk ID | Same audit sample assignment |
| Same topic, new qualifying condition | Update; qualifier retained |
| Explicit correction of a user preference | Update current preference; old version recoverable |
| Conflicting unsupported assertion | Preserve unresolved disagreement |
| Brief critical correction inside a long mixed-topic chunk | Relevant topic passes the relevance gate |
| Low-confidence same-info verdict | Writer review; no automatic bypass |
| False-positive topic match | Writer may return no change; unrelated summary remains intact |
| No topic matches but chunk contains useful information | Uncovered-content check routes to writer |
| Chunk spans two existing topics | Update both where needed |
| Existing topic plus a new topic | Update and create in the same transaction |
| Novel but transient progress chatter | No topic creation |
| Tool outputs with equal lengths but different critical content | Actual content reaches assessment; meaningful difference is preserved |
| State-changing action receipt | Exact receipt retained; no rerun implied |
| Tool call marked read-only by host metadata | Nothing protected; the writer is not forced and the classifier may bypass |
| Explicit compaction preservation instruction | Protected information survives |
| Replayed chunk | No duplicated section or update |
| Malformed response, timeout, or overlong input | Chunk left unprocessed; no commit |
| Failed budget reduction | Typed failure; prior state retained |

Primary routing metric: relevance recall—relevant chunk/topic pairs selected by Step B divided by all labeled relevant pairs. Optimize recall first; report precision, selected topics per chunk, and downstream cost to expose the tradeoff. Include chunks where a relevant correction is a small part of otherwise unrelated content.

Primary end-to-end error metric: false no-update rate—chunks requiring a relevant addition/correction that incorrectly bypass the writer, divided by all chunks requiring a change. Also report missed updates among all bypass decisions. Break misses down by relevance gate, same-info gate, and uncovered-content gate; overall accuracy can hide these errors. Track new-versus-changing confusion separately because both still invoke the writer.

Sweep the relevance and bypass confidence thresholds on the development fixtures; freeze the selected policy before evaluating held-out traces. Log policy values with both passes so decisions can be replayed. Provider confidence must be checked empirically, not assumed calibrated.

For real traces, report source-supported material disagreement among successfully compared bypasses as a proxy, then adjudicated substantive misses among reviewed bypasses as a separate estimate. Raw patch frequency and wording differences are not error metrics. Report semantic equivalence, required updates, writer regressions, and inconclusive comparisons separately; include comparator overhead in actual cost. Report eligible, sampled, completed, failed, and reviewed counts, sampling probabilities, and uncertainty intervals. Bypass-only sampling estimates error among bypasses; it does not directly yield recall or the fraction of all required updates missed. Those denominators require independently labeled updates across bypassed and non-bypassed chunks. If sampling or review is stratified, weight estimates appropriately and disclose unreviewed cases.

Track preservation of protected content, unnecessary updates, duplicate topics, total model tokens/cost, and latency. In shadow mode report potential writer-call savings separately from actual spend; in active mode include audit overhead in realized savings. Compare ordinary whole-transcript LLM summarization, always-LLM topic updates, and classifier-gated topic updates on the same transcripts, judging each summary against its sources.

Initial acceptance: all deterministic failure/idempotency cases pass; no protected-content loss or missed critical update in the hand-inspected fixtures; realistic traces expose enough classifier bypasses to justify the extra assessment call. Passing a small set authorizes experimentation, not a broad reliability claim. Keep a small held-out set separate from prompt tuning.

## 9. Worked example

Existing topic `camera-network`: “Cameras use local RTSP. Internet access is blocked at the router.”

- “Still using RTSP locally.” → no_meaningful_addition; no write.
- “The garage camera is now at 192.168.50.192.” → new_info; update the section with the device/IP mapping.
- “I forgot to apply the router setting; internet access was not blocked.” → changing_info; correct the current status and preserve that blocking is intended, not yet established.
- “Also, the outdoor Pi camera needs a battery.” → new topic, unless an existing hardware topic already covers it.
- “I’m getting coffee.” → transient; archive only.

## 10. Core invariant

A chunk is marked processed only after its relevant information is represented in committed memory, retained verbatim as a protected record, or classified as already covered/transient under the chosen policy. The raw source remains retrievable from the archive, and the host conversation is never modified. The uncertain cases are the reason the LLM path exists.
