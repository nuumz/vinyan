# A8/A9/A10 Future Hardening Task Plan
**Status:** Mixed: T1/T3 baseline closed; T2/T4/T5/T6/T7 backlog · **Owner:** Vinyan Core · **Created:** 2026-04-28 · **Last verified:** 2026-04-29

> **Document boundary:** This document owns only the future hardening backlog for proposed A8/A9/A10 extensions. Current implementation status is summarized here only to separate shipped scope from future work; source code and focused tests remain the source of truth.

This document is a backlog boundary, not a current-plan blocker. T1 and the bounded T3 baseline have been promoted, implemented, and closed. The remaining task groups below describe broader hardening work that can be promoted into new bounded implementation plans later.

## Current Closure Snapshot

| Scope | Recheck result |
|---|---|
| A5/A8/A9/A10 + Gap C current slices | Focused suite passed on 2026-04-29; no diagnostic errors found in touched docs/tests. |
| T1 A8 provenance coverage | Closed on 2026-04-29; see [a8-provenance-coverage-audit.md](a8-provenance-coverage-audit.md). |
| T3 A9 fail-open/fail-closed baseline | Closed on 2026-04-29 as an observability + tests slice; see [a9-degradation-contract.md](a9-degradation-contract.md). |
| Adjacent concurrent Phase-14 slices | Focused runtime wiring/tests passed; one remote skill import path remains hook-only unless an importer plus discovery hook is supplied. |
| Full repository sweep | Known unrelated load/benchmark/smoke/gate failures remain outside this plan and do not change this backlog boundary. |

## Boundary

| Area | Current implemented scope | Future hardening scope |
|---|---|---|
| A8 Traceable Accountability | Governance provenance envelope, SQLite persistence, routed/short-circuit trace coverage, A10 clarification provenance, goal-loop escalation provenance, escalationPath accumulation, terminal verification provenance coverage for T1 gaps | Query/replay tooling and operator reporting |
| A9 Resilient Degradation | Degradation event contract, factory bridge wiring, trace-store/provenance fail-closed behavior, tool/drafting/failure-class bridges, baseline fail-open/fail-closed matrix, cost-ledger fail-open fault-injection coverage | SLOs, circuit policy, broader chaos/fault-injection coverage, mutation-apply failure contract, optional degradation-event coverage for currently silent best-effort stores |
| A10 Goal-and-Time Grounding | Phase-boundary checks, clarification pause on drift, temporal confidence downgrade, deterministic clock, root/current goal separation, token-Jaccard drift detection | Runtime re-grounding actions beyond clarify/downgrade, operator policy knobs, longitudinal drift analytics |

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

**Goal:** Make stored provenance operationally usable, not only persisted.

| Item | Acceptance criteria |
|---|---|
| Query API | Trace store exposes query helpers by `decisionId`, `policyVersion`, `governance_actor`, and time range. |
| Replay summary | CLI/API can render a compact decision replay: actor, policy, evidence refs, reason, escalation path. |
| Backward compatibility | Legacy traces without provenance still read cleanly and are labeled `unavailable`, not corrupted. |

**Tests:** DB tests cover denormalized columns and replay formatting.

**Non-goal:** Full PROV/RDF export.

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

**Status:** Future backlog.

| Item | Acceptance criteria |
|---|---|
| Mutation-apply failure policy | Define per-tool-category fail-open/fail-closed behavior and add an unsafe-write failure test. |
| Silent best-effort stores | Decide whether cost-ledger and session/chat persistence should emit normalized degradation events, or remain local silent fail-open. |
| Session/chat fault injection | Add isolated tests proving user-visible task completion is not blocked by session/chat write loss. |

### T4 — A9 SLO and circuit-breaker hardening

**Goal:** Turn degradation events into actionable runtime policy.

| Item | Acceptance criteria |
|---|---|
| SLO counters | Degradation metrics are grouped by component, failure type, severity, and policy version. |
| Circuit policy | Repeated provider/oracle/tool failures trip a circuit with deterministic cooldown. |
| Operator visibility | API/TUI can surface current degraded components and last reason. |

**Tests:** Simulated repeated failures transition from retry to circuit-open deterministically. 

### T5 — A10 re-grounding action expansion

**Goal:** Add bounded actions beyond clarification pause and confidence downgrade.

| Candidate action | Trigger | Acceptance criteria |
|---|---|---|
| Re-run perceive/spec with root goal | Drift is detected before mutation | The task can re-anchor context without rewriting user intent silently. |
| Re-verify temporal evidence | Stale fact affects verification confidence | Verification reruns or marks output caveated before completion. |
| Ask targeted freshness question | External evidence is stale and no verifier can refresh it | `input-required` includes concrete freshness question/options. |
| Abort unsafe drift | Drift occurs after mutating tool proposal | Task refuses commit and records provenance. |

**Tests:** Add core-loop tests for at least one re-grounding action that continues after re-anchor and one action that blocks unsafe commit. 

### T6 — A10 policy tuning and analytics

**Goal:** Make goal drift detection tunable based on observed false positives/negatives.

| Item | Acceptance criteria |
|---|---|
| Threshold config | Token-Jaccard threshold can be configured with safe defaults. |
| Drift telemetry | Emit counters for `continue`, `downgrade-confidence`, `request-clarification`, and future actions. |
| Noise review | Add a fixture set of rephrased vs drifted goals and track pause rate. |
| Documentation | Document when to tune threshold vs add domain-specific normalization. |

### T7 — Non-functional cleanup after hardening

**Goal:** Reduce maintenance risk in the hardening paths.

| Item | Acceptance criteria |
|---|---|
| Core-loop complexity split | Extract goal-grounding and short-circuit trace builders without behavior changes. |
| Biome baseline cleanup | Only address warnings in touched hardening modules; do not churn unrelated files. |
| Regression safety | Existing focused A5/A8/A9/A10 tests and full typecheck remain clean. |

## Suggested Execution Order

1. ✅ T1 A8 coverage/enforcement matrix.
2. ✅ T3 A9 fail-open/fail-closed baseline.
3. T5 A10 action expansion.
4. T2/T4/T6 operational tooling and analytics.
5. T3.b/T7 cleanup and remaining hardening after behavior stabilizes.

## Promotion Criteria For Starting Implementation

- A specific task group is selected.
- Acceptance criteria are narrowed to one sprint-sized slice.
- Affected files and tests are listed before code changes.
- Current focused test baseline is green.
- The plan explicitly states whether it changes runtime behavior, docs only, or observability only.
