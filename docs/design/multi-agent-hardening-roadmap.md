# Multi-agent hardening roadmap

> Companion to `docs/design/agentic-worker-protocol.md` and the
> already-shipped multi-agent honesty contract (recursion guard, planner
> sanitizer, deterministic delegate aggregation, sub-task event isolation,
> approval bypass). Captures items deferred during the multi-agent
> hardening rounds — not because they are unimportant, but because they
> need external preconditions (API keys, real workload telemetry) or
> address latency/cost rather than correctness.

> **Last updated**: 2026-04-29. Trigger to re-evaluate: when any of the
> "When to tackle" conditions below fire in production.

## TL;DR — prioritization matrix

| # | Item | Type | When to tackle |
|---|---|---|---|
| 1 | Provider fallback chain on 429 | Latency | When free-tier 429s observed > 10% of multi-agent runs OR Anthropic key configured |
| 2 | Worker-pool semaphore for parallel delegates | Cost / Throughput | When users dispatch goals with N ≥ 5 delegates OR `workflow:delegate_timeout` rate exceeds 5% |
| 3 | Recursion guard for creative-deliverable pre-rule on sub-tasks | Latency | When sub-task spans > 60 s consistently AND `intent:strategy` traces show creative-deliverable pre-rule firing inside a delegate |
| 4 | Compression-detection threshold tuning | Calibration | After ≥ 100 production multi-step workflows have run with the compression event in place |
| 5 | Mid-stream cancel for parallel delegates | UX | When users report cancel takes > 30 s OR cost telemetry shows wasted post-cancel tokens |

## 1. Provider fallback chain on 429

**Status**: Deferred — needs paid provider API keys.

**Symptom today**: When OpenRouter free-tier rate-limits (HTTP 429), the
delegate sub-task waits the full wall-clock cap (120 s default) before the
executor's timeout kicks in and marks it failed. With three parallel
delegates, this is up to ~3 min of dead air per turn. The honesty contract
fast-paths take over (no fabrication), so the user gets an honest "agent
timed out" — but the run is unusable.

**Why deferred**: The codebase only registers OpenRouter when
`OPENROUTER_API_KEY` is present. `createDefaultRegistry` in
`src/orchestrator/factory.ts` only registers `createAnthropicProvider` as
a fallback when the OpenRouter list is empty (line ~2785). With both
present today, the registry has all four tiers covered by OpenRouter and
Anthropic is never reached. Real fix needs both keys to be live.

**Design options**

- **A. Ordered-list per tier (registry change)** — `selectByTier(tier)`
  returns the first healthy provider, with a per-provider sick state that
  decays after 60 s of no 429s. Smallest change.
- **B. Adaptive routing in core-loop** — read trace history, pick
  least-recently-failed provider. Bigger surface, harder to test.
- **C. Per-call retry with provider switch** — wrap each LLM call in a
  `tryWithFallback(providers, request)` helper. Cleanest semantics, most
  call-site changes.

**Recommended path**: A.

- Modify `LLMProviderRegistry`: add `selectAllByTier(tier)` returning the
  ordered list and a per-id sick-state map (`Map<id, { until: number }>`).
- `selectByTier` returns the first NON-sick provider; falls through if all
  are sick.
- Wrap LLM call sites (workflow planner, synthesizer, delegate sub-task's
  core-loop) with a thin retry that catches 429 → marks sick → retries
  next provider once.
- Emit `llm:provider_sick { providerId, until, reason }` for observability.

**Critical files**

- `src/orchestrator/llm/provider-registry.ts` — add `selectAllByTier`,
  sick-state map.
- `src/orchestrator/factory.ts:2763` — `createDefaultRegistry` always
  attempts Anthropic registration when its key is configured.
- `src/orchestrator/llm/openrouter-provider.ts` — already implements
  retry-after parsing; reuse the retryable-status detection.
- `src/orchestrator/llm/retry.ts` — extend with provider-switch helper.
- `src/core/bus.ts` — new `llm:provider_sick` event.

**Acceptance**

- Two providers registered for `fast`. Provider A returns 429 once;
  provider B succeeds; result has provider B's content; A is marked sick
  for 60 s; next call goes straight to B; after 60 s A is retried.
- 429 then 429 from both → original 429 surfaces (no infinite loop).
- Tests cover: single-provider passthrough, sick-state expiry, all-sick
  surfaces error, sick-state clears on first success.

**Test strategy**: Mock provider registry with two stub providers; one
throws synthetic 429 errors. Run a workflow + assert sick-state events,
fallback success, recovery.

**Effort**: ~150 LOC (registry + retry helper + event type) + 6–8 tests.

## 2. Worker-pool semaphore for parallel delegates

**Status**: Deferred — defer until workload demands.

**Symptom today**: `executeWorkflow`'s topological scheduler dispatches
every `ready` step concurrently (`workflow-executor.ts` line ~250s). For
a "split into 10 agents" goal, all ten LLM calls fire simultaneously —
guaranteed 429s on any tier-1-rate-limited provider, even paid Anthropic
(5 RPM on tier 1). Sequential or low-concurrency would actually finish
faster because retries dwarf the saved parallelism.

**Why deferred**: Real workloads today are "3 agents debate" —
concurrency 3 is fine for both providers. Risk only emerges when users
ask for ≥ 5 delegates, which has not happened.

**Design options**

- **A. Global semaphore** (`maxConcurrentLLMCalls = 4`) — simplest, one
  knob. Coarse: a knowledge-query LLM call also counts.
- **B. Per-tier semaphore** — separate `fast`/`balanced`/`powerful`
  pools. More accurate to provider rate limits, more code.
- **C. Per-provider semaphore** — matches actual rate limits. Best
  accuracy, hardest to wire because providers don't expose their limit
  config today.
- **D. Adaptive backoff on observed 429** — react instead of pre-empt.
  Reactive is slower than necessary.

**Recommended path**: A then B. Ship A first (one knob,
`workflowConfig.maxParallelDelegates ?? 3`). Promote to B when a
specific tier becomes a bottleneck.

**Critical files**

- `src/orchestrator/workflow/workflow-executor.ts` — topological
  scheduler around line 250–290. Cap `ready.slice(0, max)` per
  iteration; remaining steps wait one tick. Acquire/release a slot
  around the LLM call.
- `src/orchestrator/workflow/types.ts` — `WorkflowConfig` adds
  `maxParallelDelegates?: number`.
- `src/cli/serve.ts` — surface as `workflow.maxParallelDelegates` config
  in `vinyan.json`.

**Acceptance**

- Plan with 5 ready delegates + cap 3 → exactly 3 in-flight at any
  moment; remaining 2 dispatch as the first ones finish.
- Cap omitted → unchanged behaviour (no semaphore).
- Single-step plans bypass the semaphore (no overhead).

**Test strategy**: Mock `executeTask` with deferred resolvers; assert at
most N concurrent executions across a wider plan.

**Effort**: ~50 LOC + 3 tests.

## 3. Recursion guard for creative-deliverable pre-rule on sub-tasks

**Status**: Deferred — latency only, no correctness loss.

**Symptom today**: A sub-task's `subInput.goal` includes the bracketed
`[Original user request: <parent goal>]` (added by an earlier round of
fixes for context fidelity). When the parent goal contains
`เขียนนิยาย` / `write a story` / etc., the bracketed copy in the
sub-task's goal still matches `CREATIVE_DELIVERABLE_THAI` /
`CREATIVE_DELIVERABLE_ENGLISH` in `intent/strategy.ts`. Result: the
sub-task routes into agentic-workflow path, spawns its own planner,
runs another LLM round. The UI taskId guards already shipped prevent
plan/state corruption, but each level adds ~30–60 s of LLM latency.

The `MULTI_AGENT_DELEGATION` pre-rule already short-circuits when
`input.parentTaskId` is set; the same check belongs on
`matchesCreativeDeliverable`.

**Why deferred**: Latency only. The honesty contract still produces
correct output; just slower.

**Design options**

- **A. Symmetric guard** — add `if (input.parentTaskId) return null`
  ahead of the creative-deliverable check, mirroring the multi-agent
  guard. Risk: a delegate that legitimately needs a creative workflow
  (e.g., Author persona delegated to write a chapter) gets blocked. But
  it would still route via STU classifier's normal `general-reasoning +
  execute + none → agentic-workflow` mapping — just at lower confidence.
- **B. Recursion-depth counter** — track depth on `TaskInput` (e.g.
  `taskNestingDepth`); allow 1 level of creative recursion, block 2+.
  Solves the legitimate-delegate concern.
- **C. Smart text exclusion** — strip the bracketed user-request block
  before the regex match. Most surgical, most fragile (regex on regex).

**Recommended path**: B.

- Add `taskNestingDepth?: number` to `TaskInput` (default 0).
- Workflow executor's delegate-sub-agent dispatch increments it on
  `subInput`.
- `composeDeterministicCandidate` skips `matchesCreativeDeliverable`
  when depth ≥ 1. Multi-agent guard becomes
  `parentTaskId || depth ≥ 1` for symmetry.

**Critical files**

- `src/orchestrator/types.ts` — add `taskNestingDepth?: number` on
  `TaskInput`.
- `src/orchestrator/workflow/workflow-executor.ts:~700-720` (delegate
  case) — propagate `taskNestingDepth: (input.taskNestingDepth ?? 0) + 1`.
- `src/orchestrator/intent/strategy.ts` — extend the pre-rule guards.

**Acceptance**

- Sub-task with depth 1 + creative-deliverable trigger words →
  classified by STU as conversational/general-reasoning, NOT routed to
  creative-deliverable agentic-workflow.
- Top-level user request with creative-deliverable still routes to
  agentic-workflow (depth 0).

**Test strategy**: Unit tests in `tests/orchestrator/intent/strategy.test.ts`
covering depth=0 (fires), depth=1 (skipped), with both Thai and English
trigger goals.

**Effort**: ~40 LOC + 3 tests.

## 4. Compression-detection threshold tuning

**Status**: Deferred — needs production telemetry to calibrate.

**Symptom today**: `buildResult` emits
`workflow:synthesizer_compression_detected` when the LLM synthesizer's
output is < 25% of total step output bytes AND total > 1500 bytes,
treating it as paraphrase and falling back to a deterministic concat.
These two thresholds are first-pass numbers. They might be:

- **Too tight** (false positive): a legitimate executive summary is
  flagged as compression and the user sees raw `## stepN` headers
  instead of clean prose.
- **Too loose** (false negative): a model that paraphrases at 30%
  ratio slips through and we ship the diluted output.

**Why deferred**: We do not yet have data on how production workloads
land in the ratio×size plane. The fix is "watch the event, adjust the
constants."

**Design options**

- **A. Static config knob** — surface
  `workflow.compressionRatioFloor`, `workflow.compressionMinBytes` in
  `WorkflowConfig`; defaults match today's constants. Operators tune
  per-deployment.
- **B. Per-workflow-type thresholds** — creative workflows tolerate
  more compression than analytical ones. Requires labeling workflow
  type in the plan.
- **C. Telemetry-driven adaptive** — track ratios over time, auto-tune
  the floor by percentile. Most accurate, most code; needs persistence
  and a feedback loop.

**Recommended path**: A first. Promote to B if a specific workload type
(e.g. multi-agent debate vs research aggregation) shows divergent
calibration needs.

**Critical files**

- `src/orchestrator/workflow/workflow-executor.ts` — replace literal
  `0.25` and `1500` with `deps.workflowConfig?.compressionRatioFloor`
  and `compressionMinBytes`, defaults preserved.
- `src/orchestrator/workflow/approval-gate.ts` — `WorkflowConfig`
  shape (or its sibling in `cli/serve.ts`'s config schema).
- `vinyan.config.json` documentation in repo README.

**Acceptance**

- Running with no override → identical behaviour to today.
- Override `compressionRatioFloor: 0.4` → fewer compression detections,
  prose output preserved more often.
- Override `compressionMinBytes: 500` → catches compression on smaller
  workflows.

**Test strategy**: Two-line behaviour delta vs the existing tests in
`workflow-executor.test.ts` (tests already mock the config; just add a
`compressionRatioFloor: 0.4` variant and assert the synthesizer's output
survives unchanged).

**Effort**: ~20 LOC + 2 tests.

**Telemetry note (non-code)**: Run a query like
`SELECT compressionRatio, stepOutputBytes, taskTypeSignature FROM
task_events WHERE eventType='workflow:synthesizer_compression_detected'`
periodically and inspect the distribution. The threshold is well-tuned
when ≤ 5% of legitimate runs are flagged.

## 5. Mid-stream cancel for parallel delegates

**Status**: Deferred — broader cancellation story, larger blast radius.

**Symptom today**: User fires multi-agent task, regrets it 30 s in,
hits cancel. Parent task's wall-clock budget eventually cuts in, but
the three in-flight delegate LLM calls keep streaming until they hit
their own 120 s timeout. Net: cancel takes minutes to actually stop;
tokens consumed for work the user doesn't want; parent task in zombie
state.

**Why deferred**: Cancellation is a project-wide concern. Today there
is no first-class "cancel a running task" API. Adding it as a
delegate-only feature without addressing the broader story would
fragment the cancel surface.

**Design options**

- **A. Cooperative cancellation (poll a flag)** — every step
  dispatcher checks a `cancelled` flag at iteration boundaries. LLM
  call in flight cannot be interrupted; minimum cancel latency = the
  current step's wall-clock cap.
- **B. AbortController plumbed through executeTask → provider.fetch**
  — true mid-stream cancel; both Anthropic and OpenRouter providers
  support `AbortSignal` already in their fetch wrapper. Cancellation
  latency ≤ 1 s.
- **C. Hard worker kill (process model)** — terminate a worker
  process. Heaviest, only relevant if Vinyan adopts process isolation
  for L3 tasks.

**Recommended path**: B, as part of a project-wide cancellation
surface.

**Critical files** (for the multi-agent slice)

- `src/orchestrator/types.ts` — `TaskInput` adds optional
  `signal?: AbortSignal`.
- `src/orchestrator/workflow/workflow-executor.ts` —
  `executeWorkflow` accepts a signal in `WorkflowExecutorDeps`; passes
  it through `Promise.race` against the timeout, cascades into
  `subInput.signal`, and listens for its `abort` event to cancel
  remaining unstarted steps.
- `src/orchestrator/llm/openrouter-provider.ts`,
  `anthropic-provider.ts` — their fetch already supports `AbortSignal`
  via `request.signal`. Plumb through `LLMRequest`.
- `src/api/server.ts` — `DELETE /api/v1/tasks/:id` (does it exist?
  audit before adding) emits `task:cancel { taskId }`; orchestrator
  resolves the per-task abort controller.
- `src/core/bus.ts` — `task:cancel { taskId, reason: 'user' | 'timeout' }`
  if not already present.

**Acceptance**

- Cancel during planner phase → immediate (planner LLM call aborts).
- Cancel during delegate dispatch → all three sub-tasks abort within ~1 s
  total; output reflects "cancelled by user", honesty fast-path renders.
- Cancel after one delegate finished, two running → finished output is
  preserved in the deterministic concat; running ones marked cancelled.
- Cancel after all delegates finished but before synthesis → synthesizer
  call aborts; deterministic concat used as final output.

**Test strategy**: A new integration test in `workflow-executor.test.ts`
that creates an `AbortController`, calls `controller.abort()` mid-flight
(via timer), and asserts ≤ 2 s cancellation latency + correct partial
output assembly.

**Effort**: ~250 LOC across orchestrator + provider + types + API + 4–6
tests + 1 new bus event.

## Cross-cutting interactions

- Items 1 and 5 share the LLM provider call site. Implement 5's
  AbortSignal plumbing before 1's retry helper so the retry can honour
  the user's cancel.
- Items 2 and 5 are independent but compose well: cap = N + cancellable
  → cancel promptly drains the in-flight pool.
- Item 3 reduces the surface area Item 2 needs to handle (less recursion
  = fewer concurrent LLM calls per turn).
- Item 4 has zero coupling to others; the threshold tuning is purely
  local to `buildResult`.

## How to pick up

1. Skim "TL;DR — prioritization matrix" for current trigger.
2. Read the matching item's "Symptom today" + "Why deferred" to confirm
   the issue still matches reality.
3. Implement against "Recommended path" + "Critical files".
4. Write the tests under "Test strategy" first; iterate code until
   green.
5. Ship; update this doc's "Last updated" + cross out the row in the
   prioritization matrix.

## Axiom promotion gates — data prerequisites (A11 / A12 / A14)

> Last updated: 2026-05-01.
>
> The proposed extension axioms below remain RFC stubs. Each has a
> concrete data gate that MUST be satisfied before promotion to an
> official axiom. Faking the gate (e.g. inventing telemetry, lowering
> the threshold to "what we observe today") would defeat the purpose
> of the gate. Do not promote until the listed query passes on real
> production traffic.

### A11 — Capability Escalation

**RFC stub location**: `src/orchestrator/worker/artifact-commit.ts:98-110`
emits `commit:capability_escalation_evaluated` post-preflight, pre-write.
Today the verdict is always `decision: 'allow'` — no enforcement.

**Telemetry**: Yes. Event is wired in `src/core/bus.ts:807` and emitted
unconditionally when `opts.bus + taskId + actor` are present. Schema:
`{ taskId, actor, targets: string[], decision: 'allow' | 'deny',
reason: string }`. Coverage test:
`tests/axiom-invariants/a11-capability-escalation.test.ts`.

**Promotion gate** — ALL must hold before A11 is promoted:

- ≥ 2 weeks of continuous production telemetry on
  `commit:capability_escalation_evaluated`.
- Per-actor mutation success rate computed from the trace store joined
  with this event:
  `wilson_lb(success_count, total_count) ≥ 0.99` over `total_count ≥
  1000` traces of the same `mutation-class` (taxonomy must be defined
  first — see below).
- Mutation-class taxonomy DEFINED. Today `targets` is a flat
  `string[]`; A11 promotion needs each commit classified by mutation
  kind (e.g. `code/test/config/doc/migration`) so Wilson-LB can be
  computed per class. Adding a `class: string` field to the event is a
  prerequisite, NOT covered by the current stub.
- Revocation telemetry DEFINED. A `commit:capability_revoked` companion
  event with reason classification must exist so the promotion can
  prove revocation closes the loop on errors. Not yet wired.

**Verification query (placeholder — will need refinement once mutation
class is wired)**:

```sql
SELECT actor,
       mutation_class,
       COUNT(*) AS n,
       SUM(CASE WHEN trace_outcome = 'success' THEN 1 ELSE 0 END) AS k,
       wilson_lb_99(SUM(CASE WHEN trace_outcome = 'success' THEN 1 ELSE 0 END),
                    COUNT(*)) AS wilson_lb
  FROM capability_escalation_evaluated_event AS ev
  JOIN execution_traces AS t ON t.task_id = ev.task_id
 WHERE ev.event_ts > strftime('%s','now') - 86400 * 14
 GROUP BY actor, mutation_class
HAVING n >= 1000 AND wilson_lb >= 0.99;
```

**Do not promote A11** until the query above returns ≥ 1 actor / class
combination AND the revocation event ledger shows `0 unrevoked errors`
in the same window.

### A12 — (RFC stub, not promoted)

**Status**: Proposed. Concept defined in `docs/foundation/concept.md`
RFC section. No runtime telemetry exists yet.

**Promotion gate**: define the telemetry contract first; emit it for ≥
2 weeks; agree on a Wilson-LB or coverage threshold; THEN re-evaluate.
Do not add a config flag claiming readiness in the meantime.

### A14 — (RFC stub, not promoted)

**Status**: Proposed. Same posture as A12 — telemetry contract is the
prerequisite, and that contract has not been written. Do not promote.

## Other deferred items — data-gated, not faked

The items below were called out alongside A11 in the implementation
plan that landed the capability-token wiring (2026-05-01). Each is
intentionally deferred until real evidence exists; the section is
recorded here so a future contributor can find them when the
underlying preconditions change.

| Item | Data prerequisite | Why deferred |
|---|---|---|
| Adaptive coefficient retuning (`parameter-registry`) | ≥ 2 weeks of `parameter_adaptations` ledger entries spanning ≥ 5 task types and ≥ 100 traces per type | Tuning without that volume produces unstable ceilings; sleep-cycle's existing adaptation already moves them within bounds |
| Eventual-consistency row-level locking on remote DB targets | A2A peer running against a non-SQLite primary database (e.g. PostgreSQL replica). No such target exists in the current deployment matrix. | SQLite's single-writer semantics already serialize writes; the design only matters when the DB target supports concurrent writers |
| Optimistic-lock 412 localStorage draft preservation in vinyan-ui | Product evidence that the 412-on-stale-edit UX is a frequent user complaint (e.g. ≥ 3 reports / week on the editor surface) | Today's 412 is rare and the editor's own dirty-state tracking is sufficient. Do not add localStorage rehydration speculatively |

When any prerequisite above flips to "satisfied", open a focused
sub-task in this roadmap with: (a) which prerequisite triggered, (b)
the query / metric proving it, (c) the smallest implementation slice
that closes the gap.
