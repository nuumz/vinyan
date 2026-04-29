# A8 Traceable Accountability — Provenance Coverage Audit

**Status:** Implemented closure · **Owner:** Vinyan Core · **Created:** 2026-04-29 · **Closed:** 2026-04-29
**Source plan:** [a8-a9-a10-future-hardening-plan.md](a8-a9-a10-future-hardening-plan.md) — T1 slice
**Scope:** Inventory + classification matrix + bounded A8 provenance closure for rows #17/#18/#20/#22. A9 T3 and A10 T5 future hardening remain out of scope.

> **Document boundary**: This document owns the A8 governance-decision inventory and the missing/partial coverage list. It does NOT own A9 fail-open/closed policy (T3) or A10 re-grounding action expansion (T5); it only flags where they connect.

## Summary

| Metric | Count |
|---|---|
| Total governance-relevant trace-producing paths inventoried | 24 |
| `provenance-required` | 12 |
| `optional` | 8 |
| `exempt-by-design` | 4 |
| `provenance-required` paths currently `missing` or `partial` | **0** |

All critical short-circuit and terminal decision paths now carry `governanceProvenance` via `buildShortCircuitProvenance`, `buildGoalGroundingProvenance`, or explicit verification-policy envelopes. Core-loop governance envelope is wired through `deriveGovernanceTraceAudit()` in the Learn phase without overwriting explicit terminal-decision provenance. Fail-closed persistence is already in place for provenance-bearing traces in `TraceStore`. Intermediate escalation hops (#19/#21) are documented as exempt-by-design because terminal traces carry the replayable escalation path.

## Inventory matrix

| # | Source (file:line) | Trigger / phase | Trace kind | Classification | Current coverage | Rationale |
|---|---|---|---|---|---|---|
| **Security boundary** | | | | | | |
| 1 | [src/orchestrator/core-loop.ts:437](../../src/orchestrator/core-loop.ts) | Input validation rejection (K1.5) | `security-rejection` | provenance-required | populated | Kernel guardrail blocks the entire task; replayable audit required. |
| 2 | [src/orchestrator/core-loop.ts:450](../../src/orchestrator/core-loop.ts) | Trace recorded for security rejection | security trace emit | provenance-required | populated | `buildShortCircuitProvenance` invoked with `evidence.detections`. |
| **Intent resolution** | | | | | | |
| 3 | [src/orchestrator/core-loop.ts:2341-2362](../../src/orchestrator/core-loop.ts) | Intent type = `uncertain` / `contradictory` | `intent-clarify` / `intent-contradiction` | provenance-required | populated | Resolver surfaces ambiguity; user must clarify before any execution. |
| 4 | [src/orchestrator/core-loop.ts:1516](../../src/orchestrator/core-loop.ts) | No LLM provider available | `no-provider-escalation` | provenance-required | populated | Conversational path cannot execute; infra-unavailable governance decision. |
| 5 | [src/orchestrator/core-loop.ts:1936](../../src/orchestrator/core-loop.ts) | Direct-tool short-circuit execution | `direct-tool-shortcircuit` | provenance-required | populated | Intent resolver commits tool execution; bypasses full pipeline. |
| **Strategy routing** | | | | | | |
| 6 | [src/orchestrator/core-loop.ts:1600-1650](../../src/orchestrator/core-loop.ts) | Conversational response generated | `conversational-complete` | optional | missing | Conversational answer is informational; does not encode a governance decision. |
| **Goal-satisfaction loop** | | | | | | |
| 7 | [src/orchestrator/goal-satisfaction/outer-loop.ts:336](../../src/orchestrator/goal-satisfaction/outer-loop.ts) | Goal-loop budget exhausted | `goal-loop-escalate` | provenance-required | populated | Budget governance; `buildShortCircuitProvenance` applied. |
| 8 | [src/orchestrator/goal-satisfaction/outer-loop.ts:93-120](../../src/orchestrator/goal-satisfaction/outer-loop.ts) | Goal-loop iteration boundary | `goal-loop-iteration` | optional | missing | Intermediate iteration tracking; non-terminal. |
| **Specification phase** | | | | | | |
| 9 | [src/orchestrator/phases/phase-spec.ts:423-445](../../src/orchestrator/phases/phase-spec.ts) | Human rejects drafted spec | `spec-rejected` | provenance-required | populated | Approval gate decision; `applyRoutingGovernance` applied. |
| **Comprehension phase** | | | | | | |
| 10 | [src/orchestrator/core-loop.ts:744](../../src/orchestrator/core-loop.ts) | Stage 1 comprehension recorded | `comprehension` | optional | missing | Best-effort pre-processing; failure does not block task. |
| 11 | [src/orchestrator/core-loop.ts:813](../../src/orchestrator/core-loop.ts) | Stage 2 comprehension (if registered) | `comprehension-stage2` | optional | missing | Multi-engine comprehension is exploratory; falls back gracefully. |
| **Perception phase** | | | | | | |
| 12 | [src/orchestrator/phases/phase-perceive.ts](../../src/orchestrator/phases/phase-perceive.ts) | Perceive returns `PerceptualHierarchy` | `perceive-complete` | exempt-by-design | n/a | Input assembly; no governance decision is made here. |
| **Prediction phase** | | | | | | |
| 13 | [src/orchestrator/phases/phase-predict.ts](../../src/orchestrator/phases/phase-predict.ts) | Prediction verdict (success/timeout) | `predict-complete` | exempt-by-design | n/a | Calibration data only; SelfModel artifact, not a governance decision. |
| **Plan phase** | | | | | | |
| 14 | [src/orchestrator/phases/phase-plan.ts](../../src/orchestrator/phases/phase-plan.ts) | Decomposer produces TaskDAG | `plan-complete` | optional | missing | Plan generation is intermediate; governance is recorded at terminal verify. |
| **Spec synthesis** | | | | | | |
| 15 | [src/orchestrator/phases/phase-spec.ts](../../src/orchestrator/phases/phase-spec.ts) | Spec generation + approval gate (non-rejection path) | `spec-generated` | optional | missing | Generation itself is non-governance; only rejection (#9) is a decision. |
| **Generate phase** | | | | | | |
| 16 | [src/orchestrator/phases/phase-generate.ts](../../src/orchestrator/phases/phase-generate.ts) | Worker produces mutations | `generate-complete` | optional | missing | Outcome is determined at Verify; traces aggregate at verify level. |
| **Verification terminal paths** | | | | | | |
| 17 | [src/orchestrator/phases/phase-verify.ts:161-177](../../src/orchestrator/phases/phase-verify.ts) | Oracle contradiction unresolved at L3 | `contradiction-unresolved` | provenance-required | populated | Terminal failure carries verification-policy provenance with top conflicting oracle pair evidence. |
| 18 | [src/orchestrator/phases/phase-verify.ts:298-332](../../src/orchestrator/phases/phase-verify.ts) | L0-pinned oracle rejection (no escalation allowed) | `oracle-rejection-l0` | provenance-required | populated | User constraint `MIN_ROUTING_LEVEL:0` blocks escalation and is recorded as caller-supplied policy evidence. |
| 19 | [src/orchestrator/phases/phase-verify.ts:145-156](../../src/orchestrator/phases/phase-verify.ts) | Oracle contradiction → escalate (L<3) | `verification-escalated` | exempt-by-design | n/a | Intermediate re-route; terminal traces capture replayability through `governanceProvenance.escalationPath` instead of per-attempt traces. |
| 20 | [src/orchestrator/phases/phase-verify.ts:467-475](../../src/orchestrator/phases/phase-verify.ts) | Confidence decision = `refuse` (composite < 0.30) | `confidence-refused` | provenance-required | populated | Pipeline confidence below refuse threshold carries explicit verification-policy provenance with composite/threshold evidence. |
| 21 | [src/orchestrator/phases/phase-verify.ts:201-209](../../src/orchestrator/phases/phase-verify.ts) | Deliberation bonus triggered | `deliberation-requested` | exempt-by-design | n/a | Non-terminal retry-loop signal; the terminal trace records the resulting decision and escalation path. |
| **Goal-grounding (A10)** | | | | | | |
| 22 | [src/orchestrator/goal-grounding.ts:88-100](../../src/orchestrator/goal-grounding.ts) | Goal drift detected → downgrade confidence | `goal-drift-downgrade` | provenance-required | populated | A10 confidence attenuation now attaches `goalGroundingPolicy` provenance when learn-phase applies the downgrade. |
| 23 | [src/orchestrator/goal-grounding.ts:107+](../../src/orchestrator/goal-grounding.ts) | Goal drift → request clarification | `goal-drift-clarify` | provenance-required | populated | A10 user intervention trace carries `goalGroundingPolicy` provenance from `buildGoalGroundingProvenance`. |
| **Learn phase** | | | | | | |
| 24 | [src/orchestrator/phases/phase-learn.ts:315-320](../../src/orchestrator/phases/phase-learn.ts) | Trace persisted after all calibrations | `learn-complete` | optional | n/a | Observational emission; provenance already attached upstream by routing/verify. |

## Closed gaps from the implementation slice

The following `provenance-required` paths were missing or partial in the audit and are now populated:

- **#22 Goal-drift downgrade** ([goal-grounding.ts](../../src/orchestrator/goal-grounding.ts)) — learn-phase A10 confidence downgrade now attaches `goalGroundingPolicy` provenance with grounding-check and stale-fact evidence.
- **#23 Goal-drift clarify** ([core-loop.ts](../../src/orchestrator/core-loop.ts)) — already wired before this slice; clarification traces carry `goalGroundingPolicy` provenance from `buildGoalGroundingProvenance`.
- **#17 Contradiction unresolved at L3** ([phase-verify.ts](../../src/orchestrator/phases/phase-verify.ts)) — terminal contradiction trace now carries `verificationPolicy` provenance with top conflicting oracle pair evidence.
- **#18 L0-pinned oracle rejection** ([phase-verify.ts](../../src/orchestrator/phases/phase-verify.ts)) — terminal escalated trace now records `MIN_ROUTING_LEVEL:0` as caller-supplied policy evidence.
- **#20 Confidence refused** ([phase-verify.ts](../../src/orchestrator/phases/phase-verify.ts)) — refusal trace now carries explicit `confidence-refused` provenance with composite score, threshold, and confidence inputs.
- **#19/#21 Intermediate escalation traces** — documented as `exempt-by-design`; they are non-terminal retry/re-route hops and terminal traces carry `governanceProvenance.escalationPath` to avoid per-attempt trace cardinality explosion.

## Enforcement policy recommendation

This is the input to T3 (A9 fail-open/fail-closed matrix); T1 only proposes the A8-side default.

- **Fail closed** when a `provenance-required` trace fails to persist:
  - Security rejection (#1, #2)
  - Intent clarification / contradiction (#3)
  - No-provider escalation (#4)
  - Direct-tool short-circuit (#5)
  - Goal-loop budget escalation (#7)
  - Spec rejected (#9)
  - Contradiction unresolved at L3 (#17)
  - L0-pinned oracle rejection (#18)
  - Confidence refused (#20)
  - Goal-drift downgrade / clarify (#22, #23)
- **Degrade open** when an `optional` or `exempt-by-design` trace fails to persist (current behaviour; no change required).
- **Default rule:** `traceCollector.requiresDurablePersistence(trace) === true` ⇒ fail closed. The audit confirms this rule covers all `provenance-required` rows once gaps #17/#18/#20/#22/#23 are populated.
- **Connection to T3:** the per-subsystem fail-open vs fail-closed contracts in T3 should treat the rows above as the canonical "fail closed" set for trace-store writes. T3 still owns the SLO/circuit-breaker side of the contract.
- **Intermediate escalation exemption (#19/#21):** Oracle contradiction escalation below L3 and deliberation bonus retries are non-terminal re-routing hops. They are intentionally not trace-producing governance decisions; the terminal trace's `governanceProvenance.escalationPath` is the replay surface.

## Coverage already complete

- ✅ Goal-loop synthetic escalation provenance — `buildShortCircuitProvenance` at [outer-loop.ts:336](../../src/orchestrator/goal-satisfaction/outer-loop.ts).
- ✅ Routed/short-circuit traces (security #1-2, intent #3, no-provider #4, direct-tool #5, spec-rejected #9) carry governance provenance via `buildShortCircuitProvenance`.
- ✅ A10 goal-grounding provenance — clarification traces and confidence-downgrade traces now carry `goalGroundingPolicy` provenance; `goalGrounding: GoalGroundingCheck[]` remains the structured trace payload.
- ✅ Escalation-path accumulation — `routing.escalationPath` is propagated by `applyRoutingGovernance(trace, routing)` and accumulates L0→L1→L2→L3.
- ✅ Trace-store fail-closed for provenance traces — `TraceStore.insert()` denormalises `governance_provenance` columns; `TracePersistenceError` flows through to `escalated` task results in core-loop.

## Open questions

1. **T2 query ergonomics** — threshold values and oracle-pair details are currently stored in `GovernanceProvenance.reason` / `wasDerivedFrom`. T2 should decide which fields deserve denormalized query helpers.
2. **Multi-rejection precedence** — when multiple gates would reject (security + intent contradiction), which trace's provenance is promoted to `TaskResult.trace`? Current behavior is first-wins.

## Next steps (handoff to a future bounded slice)

This T1 closure is complete. The natural follow-on is the next task group from [a8-a9-a10-future-hardening-plan.md](a8-a9-a10-future-hardening-plan.md):

1. T3 A9 fail-open/fail-closed matrix.
2. T5 A10 action expansion.
3. T2 A8 provenance query/replay tooling, if operational trace lookup becomes the priority.

Promotion of that slice into a current plan should follow the criteria in [a8-a9-a10-future-hardening-plan.md](a8-a9-a10-future-hardening-plan.md#promotion-criteria-for-starting-implementation).
