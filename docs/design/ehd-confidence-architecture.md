# EHD Confidence Architecture — Gap Closure Design

> **Document boundary**: This document owns the **current implementation state, remaining gaps, and phased closure plan** for Epistemic Humility Deficit mitigation.
> For type definitions and resolved design conflicts, see [ehd-implementation-design.md](../research/ehd-implementation-design.md).
> For research foundations, see [epistemic-humility-deficit-2025-07.md](../research/epistemic-humility-deficit-2025-07.md).
> For 4 expert design proposals, see `design-{decision-engine,subjective-logic,pipeline-confidence,oracle-integrity}.md` in `docs/research/`.

> **Status**: Architecture Design — 75% → targeting 85% at Phase B
> **Date**: 2026-04-03 (updated)
> **Axioms**: A2 (First-Class Uncertainty), A3 (Deterministic Governance), A5 (Tiered Trust), A7 (Prediction Error)
>
> **Tracker**: Implemented & Active: C1–C4, M1, M2, M4, G11 ✅ | Phase A (wiring): G1 ✅, G2, G3 partial | Phase B (oracle layer): G4–G7 | Phase C (SL lib): G8–G10, G12

---

## 1. Architecture Decision

Vinyan's epistemic confidence system is **75% implemented**. The 4 critical deficits (C1–C4) and most moderate deficits are resolved. What remains is **wiring work** — connecting existing components that were built in isolation. No new abstractions needed for Phase A–B; Phase C adds pure library functions.

**Why wire-first, not redesign**: The SL library (`subjective-opinion.ts`), pipeline confidence, epistemic gate decision, oracle abstention, and post-hoc accuracy store all exist as working, tested modules. The gaps are at connection points — hardcoded fallbacks where real data should flow, dimensions not yet populated, stores not yet queried. Wiring preserves stability while closing gaps incrementally.

---

## 2. Current State

### Implemented (verified against code, 2026-04-02)

| Deficit | Description | Resolution | Evidence |
|---------|-------------|------------|----------|
| C1 | Confidence laundering at `buildVerdict()` | Compile-time enforcement: TypeScript requires `confidence` + `type`; `buildVerdict()` is a pass-through with no runtime validation | `src/core/index.ts` L38-43 |
| C2 | No compositional propagation | 6-step weighted geometric mean | `src/orchestrator/pipeline-confidence.ts` |
| C3 | Absence-as-evidence | Zero oracles → `NaN` + `unverified: true` | `src/gate/quality-score.ts` L47-53 |
| C4 | Circular oracle accuracy | `updateOracleAccuracy()` removed; `oracle-accuracy-store.ts` created | `src/gate/gate.ts`, `src/db/oracle-accuracy-store.ts` |
| M1 | No tests → `verified: true` | Returns `OracleAbstention` with `type: 'abstained'` | `src/oracle/test/test-verifier.ts` L56-64 |
| M2 | No linter → `verified: true` | Returns `OracleAbstention` with `type: 'abstained'` | `src/oracle/lint/lint-verifier.ts` L98-106 |
| M4 | Facts at confidence 1.0 | `confidence = min(passing oracle confidences)` | `src/orchestrator/core-loop.ts` L971-985 |
| G11 | Pipeline confidence not persisted to trace DB | `pipeline_confidence_composite` + `confidence_decision` columns in trace table; populated at Injection D | `src/db/trace-store.ts`, `src/orchestrator/core-loop.ts` L656-664 |

**Also implemented**: `SubjectiveOpinion` full SL library (fusion, Jaccard operator selection), `EpistemicGateDecision` 4-threshold system, SL aggregate in gate (`computeSLAggregate`), tier clamp (unknown → heuristic 0.9, A2A → speculative 0.4), Self-Model EMA calibration with 4 cold-start safeguards, gate verdict/abstention partitioning.

### Remaining Gaps (11 items)

| # | Gap | Where confidence leaks | Severity | Phase |
|---|-----|------------------------|----------|-------|
| G1 | ~~Test oracle success → hardcoded `1.0`~~ → returns 0.95 | Oracle layer | Low | A ✅ |
| G2 | Verification fallback `0.85`/`0.30` ignores gate aggregate | Pipeline layer | Medium | A |
| G3 | Critic dimension always `DEFAULT_NEUTRAL` (0.7) | Pipeline layer | Medium | A |
| G4 | Oracles emit scalar only, no SL opinions | Oracle layer | Medium | B |
| G5 | `temporalContext` not propagated to World Graph | Oracle → World Graph | Medium | B |
| G6 | Oracle accuracy store not wired into conflict resolver; Steps 3/4 (evidence weight, historical accuracy) in resolver are unreachable dead code — Step 2 (SL fusion) always returns before them; `oracleAccuracy` config field accepted but never read | Gate layer | High | B |
| G7 | Source independence not declared in oracle registry | Gate → SL fusion | Low | B |
| G8 | `temporalDecay()` implemented in `subjective-opinion.ts` L394-425 but never called — not yet wired into gate or pipeline | Core SL library | Low | C |
| G9 | ECP v2: SL opinions not in wire protocol | A2A layer | Low | C |
| G10 | Base rate not calibrated from prediction errors | Core SL library | Low | C |
| G12 | Sleep Cycle confidence thresholds undefined | Evolution layer | Low | C |

---

## 3. Confidence Flow Architecture

### 3.1 Three-Layer Model

Confidence flows through three increasingly compound layers. Each layer has its own aggregation strategy, justified by its scope:

```
Layer 1: Oracle          Layer 2: Gate              Layer 3: Pipeline
─────────────────       ─────────────────          ─────────────────
Per-oracle, per-hyp     Cross-oracle, per-step     Cross-step, per-task
                                                    
┌─────────┐             ┌──────────────┐           ┌─────────────────┐
│ AST     │─confidence──│              │           │                 │
│ (1.0)   │─opinion?────│  SL Fusion   │──agg──────│  Weighted       │
├─────────┤             │  (Jaccard    │  conf     │  Geometric Mean │
│ Type    │─confidence──│   operator   │           │                 │
│ (1.0)   │─opinion?────│   selection) │           │  prediction 0.15│
├─────────┤             │              │           │  meta      0.05 │
│ Test    │─confidence──│  OR harmonic │           │  planning  0.10 │
│ (0.95)  │             │  mean (A5)   │──epist────│  generation0.10 │
├─────────┤             │              │  decision │  verify    0.40 │
│ Lint    │─confidence──│              │           │  critic    0.20 │
│ (0.90)  │             └──────────────┘           └─────────────────┘
├─────────┤                    │                          │
│ Dep     │─confidence──       │                          │
│ (1.0)   │                    ▼                          ▼
└─────────┘             ┌──────────────┐           ┌─────────────────┐
      │                 │  Epistemic   │           │  Confidence     │
      │ clampFull()     │  Decision    │           │  Decision       │
      │ (tier×transport │  ≥0.85 allow │           │  ≥0.70 allow    │
      │  ×peer-trust)   │  ≥0.60 caveat│           │  ≥0.50 re-verify│
      │                 │  ≥0.25 unsure│           │  ≥0.30 escalate │
      ▼                 │  <0.25 block │           │  <0.30 refuse   │
  A5 Tiered Trust       └──────────────┘           └─────────────────┘
```

**Why three layers, not one**: A single end-to-end confidence number loses provenance. When the system refuses a task, operators need to know: was it oracle-level disagreement (conflicting verdicts), gate-level ambiguity (low aggregate), or pipeline-level compounding (weak prediction + marginal verification)? Each layer answers a different question.

### 3.2 Data Flow with Gap Annotations

```
Oracle Runners ──[scalar confidence]──→ clampFull() ──→ Gate
     │                                                    │
     │ G4: should also emit SL opinion                    │
     │ G1: test success = 1.0 (should be 0.95)            │
     │ G5: temporalContext not propagated                  │
     ↓                                                    ↓
 OracleVerdict                              computeSLAggregate()
 { confidence, type,                        + computeAggregateConfidence()
   opinion?: SubjectiveOpinion }                    │
                                                    │ G6: accuracy store not wired
                                                    │ G7: independence not declared
                                                    ↓
                                           GateVerdict { aggregateConfidence,
                                             epistemicDecision, qualityScore }
                                                    │
                                                    │ G2: fallback 0.85/0.30
                                                    ↓
                                           computePipelineConfidence()
                                           { prediction, metaPrediction,
                                             verification, critic, planning }
                                                    │
                                                    │ G3: critic not wired (always 0.7)
                                                    ↓
                                           deriveConfidenceDecision()
                                           → allow | re-verify | escalate | refuse
                                                    │
                                                    ↓
                                           World Graph: storeFact()
                                           { confidence: min(oracle), validUntil? }
                                                    │
                                                    │ G5: no validUntil from oracles
                                                    │ G8: no temporal decay
                                                    ↓
                                           Sleep Cycle / Evolution
                                                    │ G12: thresholds TBD
```

---

## 4. Responsibility Map

| Module | Owns | Key invariant |
|--------|------|---------------|
| Oracle Runners (`src/oracle/*/`) | Per-oracle confidence + opinion generation | Every verdict has explicit `confidence` + `type` (A2) |
| tier-clamp (`src/oracle/tier-clamp.ts`) | A5 confidence ceiling enforcement | `clampFull = min(tierCap, transportCap, peerTrustCap)` |
| Gate — epistemic-decision (`src/gate/epistemic-decision.ts`) | SL fusion, aggregate confidence, epistemic decision | NaN aggregate → 'block' (safe default) |
| Gate — quality-score (`src/gate/quality-score.ts`) | Compliance computation | Zero oracles → `NaN` + `unverified: true`, never `1.0` |
| Gate — conflict-resolver (`src/gate/conflict-resolver.ts`) | Oracle disagreement resolution | SL conflict constant K for contradiction detection |
| Pipeline Confidence (`src/orchestrator/pipeline-confidence.ts`) | 6-step weighted compound confidence | Zero in any dimension → composite = 0 |
| Self-Model (`src/orchestrator/self-model.ts`) | Calibration, meta-confidence, cold-start | `metaConfidence < 0.3` below 10 observations |
| Core Loop (`src/orchestrator/core-loop.ts`) | Wiring: Injection A–D, fact storage | Confidence flows through, never originates here |
| Oracle Accuracy Store (`src/db/oracle-accuracy-store.ts`) | Post-hoc accuracy tracking | Ground truth = post-deploy outcome, not gate decision |
| World Graph (`src/world-graph/`) | Fact storage with confidence + validity | Facts bound to SHA-256 file hash (A4) |
| SubjectiveOpinion (`src/core/subjective-opinion.ts`) | SL operations: fusion, projection, creation | Invariant: `b + d + u = 1` (±1e-9 tolerance) |

**Coupling alert**: Changing oracle verdict schema (`OracleVerdict` in `src/core/types.ts`) requires updating: all oracle runners, gate.ts, conflict-resolver.ts, quality-score.ts, core-loop.ts fact storage, and oracle-related tests.

---

## 5. Implementation Phases

### Phase A: Wiring Fixes — fix existing connections, no new abstractions

All items are additive guards or value corrections. Can ship independently.

| Step | Gap | Change | File(s) | Risk |
|------|-----|--------|---------|------|
| A1 | G2 | Use `verification.aggregateConfidence` when available; keep `0.85`/`0.30` as L0-only fallback | `src/orchestrator/core-loop.ts` ~L601 | Low |
| A2 | G3 | Capture critic confidence from `critic:verdict` event, pass as `critic` dim to `computePipelineConfidence()` | `src/orchestrator/core-loop.ts` ~L608 | Low |
| A3 | G1 | Test oracle success → `confidence: 0.95` (heuristic tier cap; test pass ≠ correctness proof) | `src/oracle/test/test-verifier.ts` ~L90 | Very low |

**Dependencies**: A1 ‖ A2 ‖ A3 (parallel).
**Verification**: `bun run test` — all pass.

### Phase B: Oracle Enrichment — SL opinions + accuracy wiring

| Step | Gap | Change | File(s) | Risk |
|------|-----|--------|---------|------|
| B1 | G4 | Deterministic oracles (AST, Type) add `opinion: fromScalar(confidence)` to verdict; then heuristic oracles (Test, Lint) | `src/oracle/{ast,type,test,lint}/*.ts` | Low |
| B2 | G5 | Add default `temporalContext` per oracle type (AST: 5min, Type: 10min, Test: 30min, Lint: 5min). Compute `validUntil = min(oracle TTLs)` when storing facts | `src/oracle/*/`, `src/orchestrator/core-loop.ts` ~L971 | Medium |
| B3 | G6 | Restructure conflict resolver control flow so Steps 3/4 execute (currently dead code — Step 2 always returns); then wire `oracle-accuracy-store` for historical accuracy weighting | `src/gate/conflict-resolver.ts`, `src/db/oracle-accuracy-store.ts` | High |
| B4 | G7 | Add `independence` metadata to oracle registration (e.g., AST↔Type share parse tree → `overlap: 0.3`). SL `fuseAll()` Jaccard selection already reads this | `src/oracle/registry.ts` | Low |

**Dependencies**: B1 ‖ B2 ‖ B3 (parallel). B4 depends on B3.
**Verification**: `bun run test` — opinion field present in verdicts. Conflict resolver uses accuracy. World Graph facts have `validUntil`.

### Phase C: Advanced Epistemic Features — deferred, lowest priority

| Step | Gap | Change | File(s) | Risk |
|------|-----|--------|---------|------|
| C1 | G8 | `decayOpinion(opinion, elapsedMs, halfLifeMs)` — uncertainty grows toward vacuous: $u_{\text{new}} = 1 - (1 - u) \cdot 2^{-t/h}$ | `src/core/subjective-opinion.ts` | Low |
| C2 | G10 | EMA-based base rate calibration from Self-Model prediction errors (gate: ≥30 verdicts) | `src/core/subjective-opinion.ts` or new `src/core/base-rate-calibrator.ts` | Medium |
| C3 | G12 | Define `min_confidence` thresholds for pattern promotion from Sleep Cycle | `src/sleep-cycle/` | Low |
| C4 | G9 | Optional `opinion` field in `ECPDataPartSchema`, validate `confidence ≈ projectedProbability(opinion)`, gate by `ecp_version` | `src/a2a/ecp-data-part.ts`, `src/a2a/confidence-injector.ts` | Medium |

**Dependencies**: C1 ‖ C2 (parallel, pure library). C3 depends on Phase B data. C4 depends on B1.
**Verification**: `bun run test:all`. Decayed opinions converge to vacuous. ECP messages validate.

---

## 6. Key Design Decisions

### D1: Why `fromScalar()` bridge for oracle opinions (G4)

**Context**: Oracles currently emit scalar confidence. The SL library is ready. Two options: (a) rewrite all oracles to emit native SL opinions, or (b) bridge scalars to dogmatic opinions via `fromScalar()`.

**Decision**: Bridge (b). Oracles add `opinion: fromScalar(confidence)` — zero disruption, gate already handles SL fusion via `computeSLAggregate()`.

**Trade-off**: Dogmatic opinions have `u=0` (zero uncertainty), which is epistemically dishonest for heuristic/probabilistic oracles. But this is strictly better than no opinion at all — the gate can at least fuse across oracles. Native SL opinions can be adopted per-oracle incrementally.

### D2: Why test oracle confidence = 0.95, not 1.0 (G1)

**Context**: Tests passing is strong evidence but not a proof of correctness (test coverage < 100%, test quality varies). Deterministic tier cap is 1.0, but tier cap is the ceiling — oracles should claim less when evidence is partial.

**Decision**: `0.95` for test pass. This keeps tests as the strongest heuristic signal while acknowledging they're not deterministic proofs. The `0.05` gap represents the irreducible uncertainty that "tests pass" ≠ "code is correct."

### D3: Why wire accuracy store into conflict resolver, not gate (G6)

**Context**: Oracle accuracy data could influence: (a) individual verdict confidence (pre-gate), (b) conflict resolution weights (in-gate), or (c) epistemic decision thresholds (post-gate).

**Decision**: (b) conflict resolution. Individual verdicts should reflect what the oracle *actually measured*, not what it *historically got right*. But when oracles disagree, historical accuracy is the right tiebreaker — A5 (Tiered Trust) ranks evidence by source reliability, and accuracy is the empirical measure of reliability.

**Implementation note**: The 5-step resolver algorithm in `conflict-resolver.ts` is structurally correct, but Steps 3 (evidence weight) and 4 (historical accuracy) are currently dead code — Step 2 (SL fusion) always returns early. Phase B must restructure the control flow before wiring the accuracy store.

### D4: Why hardcoded temporal defaults per oracle type (G5)

**Context**: Oracle TTLs (how long their verdicts remain valid) could be: (a) hardcoded per type, (b) computed from change frequency in World Graph, or (c) declared by the oracle itself.

**Decision**: (a) hardcoded defaults now, with (b) as Phase C upgrade path. AST facts change on file edit (~5 min reasonable TTL for active development). Type analysis is more stable (~10 min). Test results are most durable (~30 min). These defaults are conservative — slightly too short is safer than too long.

### D5: Why pipeline confidence uses weighted geometric mean, not arithmetic (existing)

**Context**: Six pipeline dimensions need combining. Arithmetic mean allows one strong dimension to compensate for a weak one. Geometric mean ensures all dimensions contribute — a zero in any dimension collapses the composite to zero.

**Decision**: Geometric mean. A task with excellent prediction but zero verification confidence should NOT be committed. The geometric mean enforces "every dimension matters" — aligned with A1 (generation ≠ verification) and A6 (zero-trust: proposals need evidence).

**Weights rationale**: Verification (0.40) and critic (0.20) together = 0.60 of total weight, because hard evidence (A5: deterministic > heuristic > probabilistic) should dominate over predictions (0.15) and meta-predictions (0.05).

---

## 7. Trade-offs

| Decision | Gain | Cost |
|----------|------|------|
| `fromScalar()` bridge for oracle opinions | Zero-disruption SL adoption; gate already handles it | Dogmatic opinions (`u=0`) lose uncertainty info until oracles emit native SL |
| Hardcoded temporal defaults per oracle type | Immediate validity tracking; conservative and safe | Not data-driven; should calibrate from real decay patterns in Phase C |
| Phase C deferred | Focus on high-impact wiring; stabilize what exists | Temporal decay and base rate calibration remain theoretical |
| Test confidence 0.95 vs 1.0 | Honest: test pass ≠ correctness proof | Slightly more conservative gate decisions for well-tested code |
| Accuracy in conflict resolver, not in verdict | Verdicts reflect measurement, not reputation | Accuracy signal hidden from quality-score computation |

---

## 8. Growth Path

### Near-term (Phase A → B)

Wire existing components. After Phase B, the confidence pipeline is fully connected end-to-end: oracles emit structured opinions → gate fuses with SL + accuracy → pipeline compounds across steps → trace DB records everything → World Graph stores facts with validity windows.

### Medium-term (Phase C)

Temporal decay makes the system time-aware — stale evidence weakens automatically. Base rate calibration makes SL opinions self-correcting. These are **data-gated**: they activate only when sufficient traces exist (≥30 verdicts for base rate, ≥100 traces for Sleep Cycle thresholds).

### Long-term (beyond this design)

| Evolution | Trigger | Scope |
|-----------|---------|-------|
| Native SL opinions per oracle | When `fromScalar()` bridge causes measurable information loss | Per-oracle refactor |
| Data-driven temporal defaults | When World Graph has ≥1000 facts with validity tracking | Replace hardcoded TTLs |
| ECP v2 wire protocol with opinions | When multi-instance coordination needs inter-agent uncertainty | `src/a2a/` protocol layer |
| Conformal prediction calibration | When oracle accuracy data shows systematic miscalibration | Add calibration layer between oracle and gate |
| Open-world mass (unknown unknowns) | Research breakthrough in quantifiable ignorance | Extend SL opinion tuple |

---

## 9. Open Questions

1. ~~**Critic wiring timing (G3)**~~ **Resolved (2026-04-03)**: Critic verdict arrives synchronously in the same execution context. `core-loop.ts` calls `criticEngine.review()` → recomputes `computePipelineConfidence()` with critic dimension inline (EHD Phase 2 block at ~L1079). No EventBus delay.

2. **Oracle accuracy granularity (G6)**: Track per-oracle-name only, or per-oracle-name × task-type? More granular = better signal, but requires more data before becoming useful.

3. **`temporalContext` availability (G5)**: If current oracle verifiers don't populate `temporalContext`, Phase B scope widens to all oracle runners — verify before committing.

---

## Appendix: Axiom Alignment

Every phase change maps to at least one axiom:

| Change | Axiom | Justification |
|--------|-------|---------------|
| G1: Test confidence 0.95 | A5 (Tiered Trust) | Heuristic evidence capped below deterministic |
| G2: Use gate aggregate | A3 (Deterministic Governance) | Routing uses actual data, not hardcoded proxy |
| G3: Wire critic | A1 (Epistemic Separation) | Critic's independent assessment enters compound |
| G4: SL opinions | A2 (First-Class Uncertainty) | Uncertainty represented, not collapsed to scalar |
| G5: temporalContext | A4 (Content-Addressed Truth) | Facts have validity windows, not eternal truth claims |
| G6: Accuracy store | A7 (Prediction Error as Learning) | Historical accuracy calibrates future conflict resolution |
| G7: Independence | A5 (Tiered Trust) | Correlated sources fused differently than independent ones |
| G8: Temporal decay | A4 + A2 | Evidence weakens over time; uncertainty is first-class |
| G9: ECP v2 opinions | A2 (First-Class Uncertainty) | Wire protocol carries uncertainty, not just confidence |
| G10: Base rate calibration | A7 (Prediction Error) | Prediction errors calibrate SL priors |
| G11: Persist to trace *(done)* | A3 (Deterministic Governance) | Decisions auditable and reproducible |
| G12: Sleep Cycle thresholds | A7 (Prediction Error) | Pattern promotion gated by evidence quality |
