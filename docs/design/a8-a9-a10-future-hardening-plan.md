# A8/A9/A10 Future Hardening Task Plan
**Status:** T1/T2/T3/T3.b/T4/T5/T6/T7 closed; core-loop split (T8) is the only remaining backlog item · **Owner:** Vinyan Core · **Created:** 2026-04-28 · **Last verified:** 2026-04-29

> **Document boundary:** This document owns only the future hardening backlog for proposed A8/A9/A10 extensions. Current implementation status is summarized here only to separate shipped scope from future work; source code and focused tests remain the source of truth.

This document is a backlog boundary, not a current-plan blocker. T1, T2, T4, T5, T6, and the bounded T3 baseline have been promoted, implemented, and closed. The remaining task groups below describe broader hardening work that can be promoted into new bounded implementation plans later.

## Current Closure Snapshot

| Scope | Recheck result |
|---|---|
| A5/A8/A9/A10 + Gap C current slices | Focused suite passed on 2026-04-29; no diagnostic errors found in touched docs/tests. |
| T1 A8 provenance coverage | Closed on 2026-04-29; see [a8-provenance-coverage-audit.md](a8-provenance-coverage-audit.md). |
| T2 A8 query/replay tooling | Closed on 2026-04-29: governance-query helpers, `GET /api/v1/governance/search`, `GET /api/v1/governance/decisions/:id/replay`, `vinyan governance` CLI, vinyan-ui Governance page. |
| T3 A9 fail-open/fail-closed baseline | Closed on 2026-04-29 as an observability + tests slice; see [a9-degradation-contract.md](a9-degradation-contract.md). Policy matrix bumped to v2 with explicit `economy-accounting-failure`, `session-persistence-failure`, and `mutation-apply-failure` (write/destructive fail-closed). |
| T4 A9 operator visibility | Closed on 2026-04-29: `DegradationStatusTracker`, Prometheus severity/component gauges, `GET /api/v1/health/degradation`, vinyan-ui status banner, config under `orchestrator.degradation`. |
| T5 A10 extended re-grounding actions | Closed on 2026-04-29 (opt-in via `extended_actions_enabled`): `re-ground-context`, `re-verify-evidence`, `ask-freshness-question`, `abort-unsafe-drift` wired through `enforceGoalGroundingBoundary`. Default behavior unchanged. |
| T6 A10 policy config | Closed on 2026-04-29: `orchestrator.goalGrounding` schema (thresholds + extended-actions toggle), `GoalGroundingPolicy` plumbed factory→core-loop, additive bus event `grounding:action_taken`. |
| Adjacent concurrent Phase-14 slices | Focused runtime wiring/tests passed; one remote skill import path remains hook-only unless an importer plus discovery hook is supplied. |
| Full repository sweep | Known unrelated load/benchmark/smoke/gate failures remain outside this plan and do not change this backlog boundary. |

## Boundary

| Area | Current implemented scope | Future hardening scope |
|---|---|---|
| A8 Traceable Accountability | Governance provenance envelope, SQLite persistence, routed/short-circuit trace coverage, A10 clarification provenance, goal-loop escalation provenance, escalationPath accumulation, terminal verification provenance coverage, governance query/replay API + CLI + UI | Long-horizon audit storage beyond traces (separate plan) |
| A9 Resilient Degradation | Degradation event contract, factory bridge wiring, trace-store/provenance fail-closed behavior, tool/drafting/failure-class bridges, baseline fail-open/fail-closed matrix v2 (mutation-apply fail-closed for write/destructive, economy/session fail-open), cost-ledger fault-injection coverage, runtime status tracker, Prometheus severity/component metrics, `/api/v1/health/degradation`, UI banner | Broader chaos coverage, generalized component circuit-breaker beyond oracle gate, optional degradation-event coverage for currently silent best-effort stores |
| A10 Goal-and-Time Grounding | Phase-boundary checks, clarification pause on drift, temporal confidence downgrade, deterministic clock, root/current goal separation, token-Jaccard drift detection, opt-in extended actions (re-ground/re-verify/ask-freshness/abort-unsafe-drift), policy config | Longitudinal drift analytics, full container-isolated re-grounding |

## Non-Goals

- Do not promote A8-A10 from proposed extensions to official axioms in this plan.
- Do not rewrite the orchestration loop solely for hardening coverage.
- Do not change confidence formulas unless a separate A5/ECP-v2 plan owns that change.
- Do not block current release readiness on this backlog.

## Task Groups

### T1 — A8 provenance coverage audit and enforcement matrix

**Status:** Closed. Authoritative closure doc: [a8-provenance-coverage-audit.md](a8-provenance-coverage-audit.md).

**Goal:** Make every governance-relevant decision either provenance-bearing or explicitly exempt.

| Item | Acceptance criteria |
|---|---|
| Inventory governance decisions | A table lists every trace-producing early return, phase return, verification terminal path, tool mutation gate, and delegation path. |
| Classify coverage | Each item is marked `provenance-required`, `optional`, or `exempt-by-design`, with rationale. |
| Enforcement policy | A small policy defines when missing provenance should fail closed vs warn. |
| Tests | Add focused tests for at least one missing/partial path discovered by the audit, or prove no missing required path remains. |

**Runtime seams to inspect:** `core-loop.ts`, `phases/*`, `goal-satisfaction/outer-loop.ts`, `trace-collector.ts`, `governance-provenance.ts`.

### T2 — A8 provenance query and replay tooling

**Status:** Closed on 2026-04-29.

**Goal:** Make stored provenance operationally usable, not only persisted.

| Item | Shipped |
|---|---|
| Query API | `TraceStore.queryGovernance({ decisionId, policyVersion, governanceActor, decisionFrom, decisionTo, limit, offset })`, `findTraceByDecisionId(id)`. |
| Replay summary | `buildDecisionReplay()` + `formatReplayForCLI()` render actor, policy, evidence, reason, escalation path; persisted confidence is never recomputed. |
| Backward compatibility | Legacy traces without provenance return `availability: 'unavailable'`. |
| Surfaces | `GET /api/v1/governance/search`, `GET /api/v1/governance/decisions/:id/replay`, `vinyan governance search|replay` CLI, vinyan-ui `/governance` page. |

**Tests:** [governance-query.test.ts](../../tests/db/governance-query.test.ts), [governance-endpoints.test.ts](../../tests/api/governance-endpoints.test.ts).

**Non-goal (still):** Full PROV/RDF export.

### T3 — A9 fail-open/fail-closed policy matrix

**Status:** Baseline closed. Authoritative contract doc: [a9-degradation-contract.md](a9-degradation-contract.md).

The implemented slice documents the current per-subsystem policy contract and adds fail-open fault-injection coverage for cost-ledger persistence. It intentionally does not change runtime behavior. Remaining T3 follow-ups are tracked as T3.b below.

**Goal:** Replace implicit best-effort choices with an explicit degradation contract per subsystem.

| Failure class | Initial policy candidate | Acceptance criteria |
|---|---|---|
| Trace persistence for governance traces | Fail closed | Already implemented; document as baseline. |
| Trace persistence for non-governance traces | Warn/degrade open | Confirm no task success depends on durable non-governance trace writes. |
| Cost/economy accounting | Degrade open | Failure never blocks task result; current behavior is silent fail-open with the in-memory cache as the authoritative read path. Optional degradation-event emission is deferred. |
| Shadow validation | Degrade open | Failure emits normalized degradation event and preserves committed result state. |
| Tool mutation failure after verification | Usually fail closed or partial | Deferred to T3.b: define per tool category; add tests for unsafe write failure. |
| Session/chat persistence | Case-by-case | Baseline contract documented as fail-open; isolated fault-injection is deferred. |

**Tests:** Baseline slice covers one fail-open subsystem beyond trace-store ([cost-ledger-degradation.test.ts](../../tests/economy/cost-ledger-degradation.test.ts)); fail-closed beyond trace-store is already covered by terminal verification tests from T1.

### T3.b — A9 degradation contract follow-ups

**Status:** Closed on 2026-04-29.

| Item | Resolution |
|---|---|
| Mutation-apply failure policy | `commitArtifacts()` upgraded to a preflight-all-before-write contract: any rejected artifact (path traversal, absolute path, symlink target, parent-symlink escape) fails the entire batch with no filesystem writes. Core-loop fails closed on **any** rejection (previously only when the batch was fully rejected) and emits one `tool:mutation_failed { toolName: 'artifact-commit', category: 'write' }` per rejected artifact. The existing degradation bridge normalizes those events to `mutation-apply-failure / fail-closed / blocked / critical`. Conservative `category: 'write'` is used because `WorkerResult.mutations` carries no per-tool provenance today; destructive classification is deferred until provenance lands. |
| Silent best-effort stores | Policy unchanged — `economy-accounting-failure` and `session-persistence-failure` remain fail-open. `CostLedger` now accepts an optional `VinyanBus` so its existing best-effort `record()` catch surfaces `economy:accounting_failed` for the bridge to normalize while keeping the in-memory cache authoritative. Session/chat persistence is left as-is; the existing matrix entry already covers normalization once a runtime emitter is added. |
| Session/chat fault injection | Cost-ledger fault-injection extended to assert `economy:accounting_failed` is emitted on INSERT failure while `queryByTask` still returns the cached entry — proving user-visible flow is not blocked. Session-store fault injection deferred (no runtime emitter yet); the bus→bridge mapping is already covered by [degradation-policy-matrix.test.ts](../../tests/orchestrator/degradation-policy-matrix.test.ts). |

**Tests:** [tests/orchestrator/worker/artifact-commit.test.ts](../../tests/orchestrator/worker/artifact-commit.test.ts) (preflight any-reject + symlink fail-closed); [tests/orchestrator/degradation-policy-matrix.test.ts](../../tests/orchestrator/degradation-policy-matrix.test.ts) (artifact-commit boundary failure normalizes fail-closed); [tests/economy/cost-ledger-degradation.test.ts](../../tests/economy/cost-ledger-degradation.test.ts) (fault-injection emits `economy:accounting_failed` and keeps cache authoritative).

### T4 — A9 SLO and circuit-breaker hardening

**Status:** Operator visibility slice closed on 2026-04-29. Generalized component circuit-breaker remains future work.

**Goal:** Turn degradation events into actionable runtime policy.

| Item | Shipped / Acceptance |
|---|---|
| SLO counters | Prometheus `vinyan_degradations_by_severity_total`, `vinyan_degradation_active`, `vinyan_degradation_fail_closed_active`, `vinyan_degradation_active_by_severity`; `vinyan_degradations_by_failure_total` extended with new failure types. |
| Circuit policy | Oracle circuit-breaker behavior unchanged. Generalized component circuit (provider/tool classes) remains future work. |
| Operator visibility | `DegradationStatusTracker` (in-memory, TTL-evicted), `GET /api/v1/health/degradation` returning `healthy`/`degraded`/`partial-outage`, vinyan-ui top-of-page banner, `orchestrator.degradation` config (`enabled`, `entry_ttl_ms`). |

**Tests:** [degradation-status.test.ts](../../tests/observability/degradation-status.test.ts) (7), prometheus and metrics-collector regression suites green.

### T5 — A10 re-grounding action expansion

**Status:** Closed on 2026-04-29. Default behavior unchanged; new actions are opt-in via `orchestrator.goalGrounding.extended_actions_enabled`.

**Goal:** Add bounded actions beyond clarification pause and confidence downgrade.

| Action | Trigger | Behavior |
|---|---|---|
| `re-ground-context` | Drift detected before mutation | Advisory `continue` + `grounding:action_taken` event. Lightweight context refresh; pipeline does not restart and user intent is never silently rewritten. |
| `re-verify-evidence` | ≥3 stale facts during/after verify | Advisory `continue` + event. Verification re-runs are caller-driven; trace is caveated. |
| `ask-freshness-question` | 1-2 stale facts, no verifier | Returns `status:'input-required'` with freshness-specific clarification question and `agent:clarification_requested` event. |
| `abort-unsafe-drift` | Drift + stale evidence after mutation proposal | Returns `status:'failed'` with `escalationReason` set; mutation is not committed. Trace outcome `failure`. |

**Tests:** [goal-grounding.test.ts](../../tests/orchestrator/goal-grounding.test.ts) extended-actions block (5 tests + legacy fallback).

### T6 — A10 policy tuning and analytics

**Status:** Config + telemetry baseline closed on 2026-04-29. Longitudinal noise review is future work.

**Goal:** Make goal drift detection tunable based on observed false positives/negatives.

| Item | Shipped / Acceptance |
|---|---|
| Threshold config | `orchestrator.goalGrounding` schema: `high_risk_score`, `long_running_budget_ms`, `elapsed_check_threshold_ms`, `freshness_confidence_floor`, `drift_similarity_threshold`, `extended_actions_enabled`. Plumbed factory→core-loop via `OrchestratorDeps.goalGroundingPolicy`. |
| Drift telemetry | `grounding:checked` extended payload + new `grounding:action_taken` bus event for non-passive actions. |
| Noise review | Test fixtures cover rephrased / drifted / containment / multilingual-ish / empty-token cases (legacy + extended). Longitudinal pause-rate review remains future work. |
| Documentation | Defaults match prior behavior; tuning guidance lives next to schema in `src/config/schema.ts`. |

### T7 — Non-functional cleanup after hardening

**Status:** Baseline closed on 2026-04-29 (Biome cleanup of touched modules + regression safety). Core-loop complexity split deferred — touched modules are stable and extraction would churn unrelated tests.

**Goal:** Reduce maintenance risk in the hardening paths.

| Item | Acceptance criteria | Status |
|---|---|---|
| Core-loop complexity split | Extract goal-grounding and short-circuit trace builders without behavior changes. | Deferred (future). |
| Biome baseline cleanup | Only address warnings in touched hardening modules; do not churn unrelated files. | Closed on 2026-04-29: `src/cli/governance.ts`, `src/orchestrator/goal-grounding.ts`, `src/observability/degradation-status.ts` clean under `bun x biome check`. Repo-wide pre-existing warnings deliberately not touched. |
| Regression safety | Existing focused A5/A8/A9/A10 tests and full typecheck remain clean. | Closed on 2026-04-29: 60/60 focused hardening tests pass; `bun x tsc --noEmit` clean (after duplicate `isUncertain?` field in `src/orchestrator/phases/types.ts` was deduplicated). |

## Suggested Execution Order

1. ✅ T1 A8 coverage/enforcement matrix.
2. ✅ T3 A9 fail-open/fail-closed baseline.
3. ✅ T2 A8 query/replay tooling.
4. ✅ T4 A9 operator visibility.
5. ✅ T6 A10 policy config.
6. ✅ T5 A10 extended re-grounding actions.
7. ✅ T7 cleanup baseline (Biome of touched modules + regression).
8. T3.b and core-loop complexity split — future backlog.

## Promotion Criteria For Starting Implementation

- A specific task group is selected.
- Acceptance criteria are narrowed to one sprint-sized slice.
- Affected files and tests are listed before code changes.
- Current focused test baseline is green.
- The plan explicitly states whether it changes runtime behavior, docs only, or observability only.
