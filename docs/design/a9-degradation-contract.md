# A9 Resilient Degradation — Fail-Open / Fail-Closed Contract Matrix v2

**Status:** v2 implemented · **Owner:** Vinyan Core · **Created:** 2026-04-29 · **Updated:** 2026-04-29 (v2)
**Source plan:** [a8-a9-a10-future-hardening-plan.md](a8-a9-a10-future-hardening-plan.md) — T3 slice
**Policy version:** `degradation-strategy:v2` (matches `DEGRADATION_POLICY_VERSION` in [src/orchestrator/degradation-strategy.ts](../../src/orchestrator/degradation-strategy.ts))

> **v2 changes:** Promotes the matrix from inline strategy to the exported `DEGRADATION_POLICY_MATRIX` constant with rationale strings; adds three new failure types — `economy-accounting-failure` (fail-open), `session-persistence-failure` (fail-open), and `mutation-apply-failure` (fail-closed) — plus their bus bridges.

> **Document boundary:** This document owns the per-subsystem fail-open vs fail-closed *policy contract*. It does NOT own the A8 governance provenance inventory (see [a8-provenance-coverage-audit.md](a8-provenance-coverage-audit.md)) or A9 SLO/circuit-breaker hardening (T4 backlog).

## Why this document exists

A9 (Proposed) requires that "component failure must degrade capability, not corrupt state or cascade. Fallback, circuit breaker, retry, and SLO behavior are governance contracts, not ad-hoc per-call defenses."

Before this slice, fail-open vs fail-closed choices lived implicitly inside try/catch blocks across the codebase. T3 makes the contract explicit, ties each decision to its source code site, and adds fault-injection coverage so the contract is testable.

Two enforcement layers carry the contract:

1. **Degradation event layer** ([src/orchestrator/degradation-strategy.ts](../../src/orchestrator/degradation-strategy.ts)) — `decideDegradation()` maps `failureType` → `{action, severity, retryable, capabilityImpact}` with policy version.
2. **Verification verdict layer** ([src/gate/gate.ts](../../src/gate/gate.ts), [src/orchestrator/phases/phase-verify.ts](../../src/orchestrator/phases/phase-verify.ts)) — config-driven (`timeout_behavior`, contradiction at L3, confidence refuse threshold) refusals that surface as task-level fail-closed without going through the degradation event.

## Per-subsystem matrix

| # | Subsystem | Failure surface | Policy | Enforcement layer | Source (file:line) | Test |
|---|---|---|---|---|---|---|
| 1 | Trace persistence — governance traces | `TraceStore.insert()` throws on disk full / SQLITE_BUSY | **Fail-closed** | Degradation event (`trace-store-write-failure` → `action:'fail-closed'`) + core-loop catch | [trace-collector.ts:195-210](../../src/orchestrator/trace-collector.ts), [core-loop.ts:2221-2245](../../src/orchestrator/core-loop.ts) | [degradation-strategy.test.ts](../../tests/orchestrator/degradation-strategy.test.ts), [core-loop-pipeline-confidence.test.ts](../../tests/orchestrator/core-loop-pipeline-confidence.test.ts) |
| 2 | Trace persistence — non-governance traces | Same insert site, non-gov trace | **Fail-open** (degrade) | Degradation event emit, no throw | [trace-collector.ts:195-210](../../src/orchestrator/trace-collector.ts) | [degradation-strategy.test.ts](../../tests/orchestrator/degradation-strategy.test.ts) |
| 3 | Cost / economy ledger | `CostLedger.record()` SQLite INSERT throws | **Fail-open** (silent degrade — cache authoritative) | Local try/catch; in-memory cache absorbs the failure so queries continue to work | [cost-ledger.ts:79-110](../../src/economy/cost-ledger.ts) | **NEW** [cost-ledger-degradation.test.ts](../../tests/economy/cost-ledger-degradation.test.ts) |
| 4 | Shadow validation | `shadow:failed` bus event when shadow worker errors | **Fail-open** (degrade) | Degradation bridge emits `oracle-unavailable / fallback`; committed task result preserved | [degradation-strategy.ts:155-167](../../src/orchestrator/degradation-strategy.ts) | [degradation-strategy.test.ts](../../tests/orchestrator/degradation-strategy.test.ts) |
| 5 | Oracle / provider transient failure | Circuit breaker trips at threshold=3 | **Fail-open** (degrade — oracle excluded) | Degradation bridge emits `oracle-unavailable / fallback`; gate aggregates remaining oracles | [circuit-breaker.ts](../../src/oracle/circuit-breaker.ts), [degradation-strategy.ts:64-72](../../src/orchestrator/degradation-strategy.ts) | [circuit-breaker.test.ts](../../tests/oracle/circuit-breaker.test.ts), [degradation-strategy.test.ts](../../tests/orchestrator/degradation-strategy.test.ts) |
| 6 | Oracle timeout — `timeout_behavior:'block'` | Configured oracle exceeds `timeout_ms` | **Fail-closed** (per-oracle config) | Verification verdict layer — gate returns `verified:false, errorCode:'TIMEOUT'` and the verification phase blocks the task | [gate.ts:344-381](../../src/gate/gate.ts) | [config.test.ts:131-155](../../tests/config/config.test.ts) (defaults) — runtime path uses real oracles in [gate.test.ts](../../tests/gate/gate.test.ts) |
| 7 | Oracle timeout — `timeout_behavior:'warn'` | Same as #6 with `warn` config | **Fail-open** (oracle excluded) | Gate returns `null` for the timed-out oracle; aggregation continues | [gate.ts:368-371](../../src/gate/gate.ts) | [config.test.ts:138-155](../../tests/config/config.test.ts) |
| 8 | Verification contradiction at L3 | All routing levels exhausted, oracles still conflict | **Fail-closed** (terminal) | Verification verdict layer — task result is `failed` with `verificationPolicy` provenance (decisionId `contradiction-unresolved`) | [phase-verify.ts:161-177](../../src/orchestrator/phases/phase-verify.ts) | [contradiction-escalation.test.ts](../../tests/orchestrator/contradiction-escalation.test.ts) |
| 9 | Oracle rejection with `MIN_ROUTING_LEVEL:0` constraint | Caller pins routing at L0 and oracles reject | **Fail-closed** (caller-policy-driven) | Verification verdict layer — task result is `escalated` with `oracle-rejection-l0-pinned` provenance | [phase-verify.ts:298-332](../../src/orchestrator/phases/phase-verify.ts) | [contradiction-escalation.test.ts](../../tests/orchestrator/contradiction-escalation.test.ts) |
| 10 | Confidence refuse boundary | Composite confidence < `PIPELINE_THRESHOLDS.ESCALATE` (0.30) | **Fail-closed** (refuse to commit) | Verification verdict layer — task result is `refused` with `confidence-refused` provenance | [phase-verify.ts:467-475](../../src/orchestrator/phases/phase-verify.ts) | [core-loop-pipeline-confidence.test.ts](../../tests/orchestrator/core-loop-pipeline-confidence.test.ts) |
| 11 | Worker / LLM provider error | `worker:error` bus event | **Fail-open** (retry then degrade) | Degradation bridge classifies as `rate-limit` or `llm-provider-failure`; retry policy handled upstream | [degradation-strategy.ts:73-82](../../src/orchestrator/degradation-strategy.ts) | [degradation-strategy.test.ts](../../tests/orchestrator/degradation-strategy.test.ts) |
| 12 | Tool failure (post-classification) | `tool:failure_classified` bus event | **Fail-open** (retry / remediate) | Degradation bridge emits `tool-timeout` or `tool-failure` action `retry`; remediation runs in-loop | [degradation-strategy.ts:91-100](../../src/orchestrator/degradation-strategy.ts) | [degradation-strategy.test.ts](../../tests/orchestrator/degradation-strategy.test.ts) |
| 13 | Tool remediation exhausted | `tool:remediation_failed` bus event | **Fail-open at degradation, fail-closed at task** | Bridge emits `tool-failure / retry`; verify phase ultimately refuses if no fallback succeeds | [degradation-strategy.ts:170-178](../../src/orchestrator/degradation-strategy.ts) | [degradation-strategy.test.ts](../../tests/orchestrator/degradation-strategy.test.ts) |
| 14 | Session / chat persistence | `recordTaskOutcome()` SQLite write fails | **Fail-open** (silent degrade) | Local try/catch logs and continues; user-visible task completes | [session-manager.ts:377-392](../../src/api/session-manager.ts), [core-loop.ts:4097-4100](../../src/orchestrator/core-loop.ts) | Isolated fault-injection deferred to T3.b |
| 15 | Budget pressure | `task:budget-exceeded` bus event | **Fail-open** (degrade routing level) | Bridge emits `budget-pressure / degrade`; budget-enforcer caps routing | [degradation-strategy.ts:101-109](../../src/orchestrator/degradation-strategy.ts) | [economy-wiring.test.ts](../../tests/economy/economy-wiring.test.ts) |
| 16 | Peer disconnect (federation) | `peer:disconnected` bus event | **Fail-open** (degrade) | Bridge emits `peer-unavailable / degrade`; federation routes to remaining peers | [degradation-strategy.ts:140-148](../../src/orchestrator/degradation-strategy.ts) | [degradation-strategy.test.ts](../../tests/orchestrator/degradation-strategy.test.ts) |

## Default policy table (`DEGRADATION_POLICY_VERSION = degradation-strategy:v2`)

The degradation event layer encodes:

| `failureType` | `action` | `capabilityImpact` | `retryable` | `severity` |
|---|---|---|---|---|
| `trace-store-write-failure` | **fail-closed** | blocked | false | critical |
| `mutation-apply-failure` | **fail-closed** | blocked | false | critical |
| `oracle-unavailable` | fallback | reduced | true | warning |
| `llm-provider-failure` | retry | reduced | true | warning |
| `tool-timeout` | retry | reduced | true | warning |
| `tool-failure` | retry | reduced | true | warning |
| `rate-limit` | degrade | reduced | true | warning |
| `peer-unavailable` | degrade | reduced | true | warning |
| `budget-pressure` | degrade | reduced | true | warning |
| `economy-accounting-failure` | degrade | reduced | true | warning |
| `session-persistence-failure` | degrade | reduced | true | warning |

`trace-store-write-failure` and `mutation-apply-failure` are the fail-closed actions encoded directly in the degradation matrix. Other fail-closed contracts in the system (rows #6, #8, #9, #10) are enforced at the **verification verdict layer**, not via the degradation event. Both layers count as A9 contracts; the matrix above marks the layer that owns enforcement.

## Tool mutation post-verification — anchored at write/destructive boundary

v2 promotes the previously-deferred `mutation-apply-failure` failure type. Read-only tool failures (row #12) continue to fail open via `tool-failure / retry`. Write/destructive workspace mutations that fail after classification emit `tool:mutation_failed { category: 'write' | 'destructive' }`, which the bridge normalizes to `mutation-apply-failure / fail-closed` so a partial mutation never silently commits. Anchor location: `commitArtifacts` / workspace mutation boundary in [core-loop.ts](../../src/orchestrator/core-loop.ts).

## Fault-injection coverage

T3's acceptance criterion is "fault-injection tests for one fail-open and one fail-closed subsystem beyond trace-store". This slice adds the missing fail-open coverage; the matching fail-closed coverage was added by the T1 slice.

| Test | Subsystem | Contract | Slice |
|---|---|---|---|
| [cost-ledger-degradation.test.ts](../../tests/economy/cost-ledger-degradation.test.ts) — `record() absorbs SQLite INSERT failure and keeps the cache authoritative` | Cost ledger (#3) | **Fail-open** beyond trace-store: SQL exception is absorbed, in-memory cache stays authoritative, downstream queries continue to work. | T3 (NEW) |
| [contradiction-escalation.test.ts](../../tests/orchestrator/contradiction-escalation.test.ts) — `L3 contradiction unresolved produces fail-closed task result` | Verification verdict (#8) | **Fail-closed** beyond trace-store: terminal contradiction at L3 fails closed with `verificationPolicy` provenance. | T1 (existing) |
| [core-loop-pipeline-confidence.test.ts](../../tests/orchestrator/core-loop-pipeline-confidence.test.ts) — `confidence below refuse boundary fails closed` | Verification verdict (#10) | **Fail-closed** at verification verdict layer (composite < 0.30). | T1 (existing) |
| [degradation-strategy.test.ts](../../tests/orchestrator/degradation-strategy.test.ts) — `trace collector emits trace write failure and bridge normalizes it` | Trace store via bus bridge | **Fail-closed** end-to-end through the bus bridge — included for completeness. | A9 MVP (existing) |

## Promotion criteria summary (already met for this slice)

- ✅ One sprint-sized slice
- ✅ Affected files and tests listed before code changes (this doc + 1 new test file)
- ✅ Existing focused A5/A8/A9/A10 tests remain green
- ✅ Slice is **observability + tests only**; no runtime behavior change

## Follow-on backlog (out of scope here)

- T4 — SLO counters, deterministic circuit cooldown, operator visibility for degraded components.
- T3.b — `mutation-apply-failure` failure type and per-tool-category policy.
- T3.b — Optional degradation-event emission for cost-ledger/session-chat persistence if silent fail-open is no longer enough.
- T6 — A10 policy tuning telemetry.
- Isolated fault-injection for session/chat persistence (#14).

Promotion follows the criteria in [a8-a9-a10-future-hardening-plan.md](a8-a9-a10-future-hardening-plan.md#promotion-criteria-for-starting-implementation).
