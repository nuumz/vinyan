# EHD Implementation Design: Unified Epistemic Confidence Architecture

> **Status:** Implementation Design (approved for development)
> **Date:** 2026-04-01
> **Author:** Architecture synthesis of 4 expert designs
> **Axioms:** A2 (First-Class Uncertainty), A3 (Deterministic Governance), A5 (Tiered Trust), A7 (Prediction Error as Learning)
> **Source documents:**
> - [design-decision-engine.md](./design-decision-engine.md) -- Decision Engine (DE)
> - [design-subjective-logic.md](./design-subjective-logic.md) -- Subjective Logic (SL)
> - [design-pipeline-confidence.md](./design-pipeline-confidence.md) -- Pipeline Confidence (PC)
> - [design-oracle-integrity.md](./design-oracle-integrity.md) -- Oracle Integrity (OI)
> - [ehd-synthesis.md](./ehd-synthesis.md) -- Original research synthesis

---

## 1. Executive Summary

Vinyan's epistemic architecture is philosophically sound but operationally leaky. Four independent design proposals converge on a single diagnosis: confidence enters the system uncalibrated (`buildVerdict()` defaults to 1.0), propagates without compounding (6-step pipeline has no composite uncertainty), and exits without provenance (binary allow/block collapses all nuance). This document merges all four proposals into a unified type system, resolves conflicts between them, and defines a phased implementation roadmap that closes the four critical deficits (C1: confidence laundering, C2: no compositional propagation, C3: absence-as-evidence, C4: circular accuracy) while maintaining backward compatibility at every step.

---

## 2. Unified Type System

### 2.1 Design Principle: Three Layers of Confidence

The four proposals define confidence at three distinct layers. These are complementary, not competing:

| Layer | Scope | Type | Owner |
|-------|-------|------|-------|
| **Oracle-level** | Single oracle's verdict on a single hypothesis | `SubjectiveOpinion` (SL) mapped to scalar `confidence` | Oracle runners |
| **Gate-level** | Aggregate across all oracles for one verification step | `AggregateConfidence` (DE) = `verification` field in Pipeline | Gate pipeline |
| **Pipeline-level** | Compound across all 6 orchestrator steps | `PipelineConfidence` (PC) | Orchestrator core loop |

### 2.2 SubjectiveOpinion (from SL)

The foundational epistemic primitive. Lives in `src/core/subjective-opinion.ts`.

```typescript
/**
 * Subjective Logic opinion tuple (Josang, 2016).
 *
 * Invariants:
 *   b + d + u = 1
 *   0 <= b, d, u <= 1
 *   0 < a < 1
 *
 * Projected probability: P = b + a * u
 * When u = 0, reduces to standard probability.
 * When u = 1, reduces to prior.
 */
export interface SubjectiveOpinion {
  belief: number;
  disbelief: number;
  uncertainty: number;
  baseRate: number;
}
```

**Helper functions** (same file):
- `fromScalar(confidence, baseRate?)` -- Phase A shim: scalar to dogmatic opinion
- `projectedProbability(o)` -- P = b + a * u
- `vacuous(baseRate?)` -- No evidence: {0, 0, 1, a}
- `dogmatic(belief, baseRate?)` -- Full certainty: {b, 1-b, 0, a}
- `isVacuous(o, threshold?)` -- u > 0.95
- `isValid(o)` -- b + d + u = 1 check
- `resolveOpinion(verdict, baseRate?)` -- Return explicit opinion or derive from scalar

### 2.3 OracleAbstention (from OI)

A new first-class return type for oracles that cannot evaluate. Lives in `src/core/types.ts`.

```typescript
export interface OracleAbstention {
  type: "abstained";
  reason: AbstentionReason;
  oracleName: string;
  durationMs: number;
  prerequisites?: string[];
}

export type AbstentionReason =
  | "no_test_files"
  | "no_linter_configured"
  | "out_of_domain"
  | "insufficient_data"
  | "timeout"
  | "circuit_open"
  | "target_not_found";

export type OracleResponse = OracleVerdict | OracleAbstention;

export function isAbstention(response: OracleResponse): response is OracleAbstention {
  return response.type === "abstained";
}
```

**Relationship to SL vacuous opinion:** An abstention is the behavioral expression of a vacuous opinion. In SL terms, an abstaining oracle contributes `{b=0, d=0, u=1, a=0.5}`. However, `OracleAbstention` is a distinct type (not an `OracleVerdict`) because:
- Abstentions are excluded from conflict resolution entirely
- Abstentions do not count for/against quality score compliance
- Abstentions surface missing infrastructure (observability concern)
- The distinction is semantic: "I could not run" vs "I ran and found nothing"

### 2.4 EpistemicGateDecision (from DE)

Replaces the binary allow/block at the gate boundary. Lives in `src/gate/types.ts`.

```typescript
export type EpistemicGateDecision =
  | "allow"              // High confidence pass
  | "allow-with-caveats" // Pass but low confidence -- proceed, flag for monitoring
  | "uncertain"          // Mixed signals -- escalate verification (NOT a failure)
  | "block";             // Clear failure -- reject

export interface ConfidenceThresholds {
  HIGH_CONFIDENCE: number;     // default 0.85
  ADEQUATE_CONFIDENCE: number; // default 0.60
  LOW_CONFIDENCE: number;      // default 0.40
  UNCERTAIN: number;           // default 0.25
}
```

### 2.5 PipelineConfidence (from PC)

Tracks compound uncertainty across the orchestrator's 6-step pipeline. Lives in `src/orchestrator/pipeline-confidence.ts`.

```typescript
export interface PipelineConfidence {
  prediction: number;
  metaPrediction: number;
  planning: number;
  generation: number;
  verification: number;     // <-- This IS the gate-level aggregate (DE's aggregateConfidence)
  critic: number;
  composite: number;        // Weighted geometric mean of above
  formula: string;          // Human-readable derivation (A3 auditability)
  dataAvailability: {
    predictionAvailable: boolean;
    planningAvailable: boolean;
    criticAvailable: boolean;
  };
}
```

### 2.6 Relationship Resolution

| DE's `AggregateConfidence` | = | PC's `verification` field | Gate-level aggregate of oracle confidences |
|---|---|---|---|
| PC's `PipelineConfidence.composite` | = | Full 6-step compound score | Orchestrator-level |
| DE's `EpistemicGateVerdict.aggregateConfidence` | = | `PipelineConfidence.verification` | Same value, different context |
| SL's `projectedProbability(fusedOpinion)` | replaces | DE's aggregate formula | Phase 3 only |

**In short:** `aggregateConfidence` (DE) and `verification` (PC) are the same value. Pipeline adds the other 5 steps on top. SL fusion eventually replaces the arithmetic aggregate but produces the same scalar output via `projectedProbability()`.

### 2.7 Extended OracleVerdict

```typescript
export interface OracleVerdict {
  // ... all existing fields unchanged ...
  confidence: number;                    // ALWAYS present, scalar [0,1]
  opinion?: SubjectiveOpinion;           // Phase B+: SL opinion tuple
  rawOpinion?: SubjectiveOpinion;        // Unclamped opinion for audit
  temporalContext?: TemporalContext;      // TTL + decay model (all oracles must populate)
}
```

### 2.8 Extended GateVerdict

```typescript
export interface GateVerdict {
  // Existing (backward compat)
  decision: GateDecision;                          // "allow" | "block"
  reasons: string[];
  oracle_results: Record<string, OracleVerdict>;
  durationMs: number;
  qualityScore?: QualityScore;
  riskScore?: number;

  // New epistemic fields
  oracle_abstentions?: Record<string, OracleAbstention>;
  epistemicDecision?: EpistemicGateDecision;
  aggregateConfidence?: number;
  caveats?: string[];
  resolutionHint?: UncertaintyResolutionHint;
}
```

### 2.9 Extended ExecutionTrace

```typescript
export interface ExecutionTrace {
  // ... all existing fields unchanged ...
  verificationConfidence?: number;
  epistemicDecision?: EpistemicGateDecision;
  pipelineConfidence?: PipelineConfidence;
  confidenceDecision?: {
    action: 'allow' | 're-verify' | 'retry' | 'escalate' | 'refuse';
    confidence: number;
    reason?: string;
  };
  outcome: "success" | "failure" | "timeout" | "escalated"; // "escalated" is new
}
```

### 2.10 Extended QualityScore

```typescript
export interface QualityScore {
  architecturalCompliance: number;  // NaN when unverified
  efficiency: number;
  testPresenceHeuristic?: number;   // Renamed from testMutationScore
  composite: number;                // NaN when unverified
  dimensionsAvailable: number;
  phase: number;
  unverified: boolean;              // NEW: true when no oracles produced verdicts
}
```

---

## 3. Design Decisions: Conflicts Resolved

### 3.1 Aggregate Formula: Harmonic vs Geometric vs SL Fusion

**Disagreement:**
- DE proposes weighted harmonic mean (very aggressive penalty on outliers)
- PC proposes weighted geometric mean (moderate penalty)
- SL proposes fusion operators (theoretically optimal, needs infrastructure)

**Resolution: Weighted harmonic mean for gate-level, weighted geometric mean for pipeline-level.**

**Justification:** The two formulas operate at different layers and serve different purposes:

- **Gate-level** (oracle aggregation): Weighted harmonic mean is correct. A single low-confidence oracle should dominate because verification is a chain -- one weak link breaks it. The harmonic mean's property of penalizing outliers matches epistemic principle: `[0.95, 0.95, 0.10]` should yield ~0.25 (uncertain), not 0.67 (adequate).

- **Pipeline-level** (6-step compound): Weighted geometric mean is correct. Pipeline steps are partially dependent (prediction informs planning). Pure multiplication (0.8^6 = 0.26) is too pessimistic. The geometric mean with verification weighted at 0.40 correctly anchors on the hard evidence while reflecting upstream uncertainty.

- **Phase 3**: SL fusion replaces the harmonic mean at gate-level. The `projectedProbability(fusedOpinion)` becomes `aggregateConfidence`. The geometric mean at pipeline-level remains unchanged (it consumes the SL-derived verification score as one input).

**Zero-oracle edge case:**
- DE: `computeAggregateConfidence` returns 1.0 for zero oracles (WRONG)
- OI: Returns NaN + `unverified: true` (CORRECT)
- **Resolution:** NaN + `unverified: true`. Zero oracles is not "everything is fine" -- it is indeterminate. Gate decision for zero oracles at L1+ is "block" with reason "insufficient evidence."

### 3.2 Threshold Values

**Disagreement:**
- DE defines 4 thresholds: HIGH=0.85, ADEQUATE=0.60, LOW=0.40, UNCERTAIN=0.25
- PC defines 3 thresholds: ADEQUATE=0.70, RE_VERIFY=0.50, REFUSE=0.30

**Resolution: Unified 4-threshold system from DE, with PC's thresholds mapped.**

```typescript
export const DEFAULT_THRESHOLDS: ConfidenceThresholds = {
  HIGH_CONFIDENCE: 0.85,     // Fast-path allow
  ADEQUATE_CONFIDENCE: 0.60, // Normal allow / allow-with-caveats boundary
  LOW_CONFIDENCE: 0.40,      // Escalation zone
  UNCERTAIN: 0.25,           // Human review zone
};
```

**Mapping:** PC's `ADEQUATE` (0.70) was for pipeline composite; DE's `ADEQUATE_CONFIDENCE` (0.60) is for gate-level aggregate. These are not in conflict -- they apply at different layers. The pipeline decision logic uses its own thresholds on the composite score:
- composite >= 0.70: allow
- 0.50 <= composite < 0.70: re-verify
- 0.30 <= composite < 0.50: escalate
- composite < 0.30: refuse

The gate-level thresholds (DE) drive `EpistemicGateDecision`. The pipeline thresholds (PC) drive `ConfidenceDecision`. Both are deterministic (A3).

### 3.3 Abstention: Separate Type vs Vacuous Opinion

**Disagreement:**
- OI proposes `OracleAbstention` as a distinct type with `type: "abstained"`
- SL proposes vacuous opinion `{b=0, d=0, u=1, a=0.5}` within `OracleVerdict`

**Resolution: Both. `OracleAbstention` is the API type; vacuous opinion is the SL representation.**

**Justification:** They serve different consumers:
- `OracleAbstention` is the oracle runner's return type. It has structured fields (`reason`, `prerequisites`) that are meaningless in an opinion tuple.
- When the gate needs to reason about the epistemic state, an abstention maps to a vacuous opinion: `{b=0, d=0, u=1, a=0.5}`.
- Abstentions are excluded from conflict resolution (they have no opinion to conflict with).
- Abstentions are excluded from SL fusion (vacuous opinions are filtered by `isVacuous()` before fusion).

The `isEffectivelyVacuous()` function from SL (ss9.5) handles the Phase A case where opinions are absent but the verdict looks vacuous based on heuristics.

### 3.4 buildVerdict() Redesign: Required Confidence vs SL Opinion

**Disagreement:**
- OI proposes removing defaults -- `confidence` and `type` become required
- SL proposes adding optional `opinion` alongside `confidence`

**Resolution: OI's required-confidence-and-type first (Phase 2), then SL's optional opinion (Phase 3).**

**Justification:** OI's change eliminates the root cause (C1: confidence laundering) at compile time. SL's opinion is an enrichment that builds on top. The migration sequence:
1. Phase 2: `buildVerdict()` requires `confidence` and `type` -- 30+ call sites updated
2. Phase 3: `buildVerdict()` accepts optional `opinion` -- oracles enriched incrementally
3. When `opinion` is provided, `confidence` is auto-computed as `projectedProbability(opinion)`

OI's `buildVerdict()` contract is compatible with SL -- it merely ensures that whatever confidence representation is used, the oracle provides it explicitly.

### 3.5 Oracle Accuracy: Circular vs Post-Hoc

All four designs agree: the current `updateOracleAccuracy()` (measuring agreement with own gate decision) is circular and must be replaced. OI provides the detailed post-hoc design (Section 5). No conflict.

### 3.6 Retry/Escalation: "Uncertain" Handling

**Disagreement (minor):**
- DE: "uncertain" escalates routing level, does NOT consume a retry
- PC: Re-verification at higher level, DOES count against retry budget (max 1 re-verify before fallback)

**Resolution: DE's approach -- "uncertain" escalates without consuming retry, but with a cap.**

**Justification:** DE's insight is correct: uncertainty is not failure. The same code may pass with deeper oracles. Consuming a retry penalizes the generation when the problem is insufficient verification. However, we add PC's safeguard: maximum 2 verification escalations per task to prevent infinite loops.

```typescript
interface RetryBudget {
  generationRetries: number;           // Consumed by "block" -- regenerate
  verificationEscalations: number;     // Consumed by "uncertain" -- re-verify only
  maxGenerationRetries: number;        // From input.budget.maxRetries
  maxVerificationEscalations: number;  // 2 (fixed)
}
```

### 3.7 World Graph Fact Confidence

**Agreement across OI and PC:** Facts stored at `confidence: 1.0` must use actual oracle confidence instead.

**Resolution: Minimum oracle confidence** (OI recommendation). The most conservative, requires no SL infrastructure.

```typescript
function computeFactConfidence(verdicts: Record<string, OracleVerdict>): number {
  const passingConfidences = Object.values(verdicts)
    .filter(v => v.verified)
    .map(v => v.confidence);
  if (passingConfidences.length === 0) return 0;
  return Math.min(...passingConfidences);
}
```

Phase 3 upgrade: Use `projectedProbability(fusedOpinion)` from SL fusion instead.

---

## 4. Implementation Roadmap

### Phase 0: Quick Wins (zero breaking changes, immediate ship)

No behavioral changes. Pure additions and renames.

| # | Change | File(s) | Test strategy |
|---|--------|---------|---------------|
| 0.1 | Create `SubjectiveOpinion` type + helpers + Zod schema | `src/core/subjective-opinion.ts` (NEW) | Unit tests for all helper functions, invariant validation |
| 0.2 | Add `OracleAbstention` type + `isAbstention()` guard | `src/core/types.ts` | Type-level tests (compile-time) |
| 0.3 | Add `OracleResponse = OracleVerdict \| OracleAbstention` | `src/core/types.ts` | Type-level tests |
| 0.4 | Add `unverified: boolean` to `QualityScore` (optional, default false) | `src/core/types.ts` | Existing tests pass unchanged |
| 0.5 | Add `oracle_abstentions` to `GateVerdict` (optional, default `{}`) | `src/gate/types.ts` or `src/core/types.ts` | Existing tests pass unchanged |
| 0.6 | Rename `testMutationScore` to `testPresenceHeuristic` | `src/core/types.ts`, `src/gate/quality-score.ts`, tests | Find-and-replace, run full test suite |
| 0.7 | Add `opinion?: SubjectiveOpinion` to `OracleVerdict` | `src/core/types.ts` | Existing tests pass (field is optional) |
| 0.8 | Create `PipelineConfidence` type + `computePipelineConfidence()` | `src/orchestrator/pipeline-confidence.ts` (NEW) | Unit tests with reference values from PC design |
| 0.9 | Add `EpistemicGateDecision` type + `ConfidenceThresholds` | `src/gate/epistemic-decision.ts` (NEW) | Unit tests for threshold logic |
| 0.10 | Create `oracle_accuracy` SQLite table | `src/db/` migration | Migration test |
| 0.11 | Add JSDoc to `architecturalCompliance` clarifying it measures weighted oracle pass ratio | `src/core/types.ts` | No test needed |

**Dependencies:** None. All items are independent.
**Risk:** None -- purely additive.

### Phase 1: Default Corrections (minor behavioral changes)

| # | Change | File(s) | Depends on | Test strategy |
|---|--------|---------|------------|---------------|
| 1.1 | Change unknown tier default from "deterministic" to "heuristic" | `src/oracle/tier-clamp.ts`, `src/gate/conflict-resolver.ts`, `src/gate/quality-score.ts` | 0.x | Test: `clampByTier(1.0, "unknown_tier")` returns 0.9, not 1.0 |
| 1.2 | Change external oracle default tier to "speculative" | `src/oracle/tier-clamp.ts` | 0.x | Test: `clampByTier(1.0, undefined, "a2a")` returns 0.4 |
| 1.3 | Zero-oracle `architecturalCompliance` from 1.0 to NaN + `unverified: true` | `src/gate/quality-score.ts` | 0.4 | Test: `computeQualityScore({}, 100)` returns NaN + unverified |
| 1.4 | Guard all consumers of `qualityScore.composite` against NaN | `src/orchestrator/core-loop.ts`, `src/orchestrator/self-model.ts` | 1.3 | Test: Self-model does not calibrate on NaN composite |
| 1.5 | World Graph facts: use `min(oracle.confidence)` instead of 1.0 | `src/orchestrator/core-loop.ts` | None | Test: fact confidence = min of passing oracle confidences |

**Dependencies:** Phase 0 must be complete.
**Risk:** Low. Unknown tier default change makes the system slightly more conservative. NaN compliance requires consumer guards (1.4).

### Phase 2: Oracle Integrity (behavioral changes)

| # | Change | File(s) | Depends on | Test strategy |
|---|--------|---------|------------|---------------|
| 2.1 | Test oracle returns `OracleAbstention` for no-test-files | `src/oracle/test/test-verifier.ts` | 0.2, 0.5 | Test: mock workspace with no tests |
| 2.2 | Lint oracle returns `OracleAbstention` for no-linter | `src/oracle/lint/lint-verifier.ts` | 0.2, 0.5 | Test: mock workspace with no linter |
| 2.3 | Gate partitions results into verdicts + abstentions | `src/gate/gate.ts` | 2.1, 2.2 | Test: gate handles mixed verdicts/abstentions |
| 2.4 | Conflict resolver excludes abstentions | `src/gate/conflict-resolver.ts` | 2.3 | Test: abstention does not conflict |
| 2.5 | Quality score handles abstentions + NaN compliance | `src/gate/quality-score.ts` | 1.3, 2.3 | Test: all-abstention = NaN |
| 2.6 | `buildVerdict()` removes defaults -- `confidence` + `type` required | `src/core/index.ts` | None | TypeScript compiler surfaces all 30+ broken call sites |
| 2.7 | Update all oracle call sites with explicit confidence per OI Standards Table | All oracle verifiers (24 files, ~66 call sites) | 2.6 | Per-oracle confidence standard tests |
| 2.8 | All oracles populate `temporalContext` | All oracle verifiers | 2.7 | Test: TTL values per OI Section 7 |
| 2.9 | Propagate `temporalContext` into World Graph stored facts | `src/orchestrator/core-loop.ts` | 1.5, 2.8 | Test: fact.validUntil = min(oracle.validUntils) |

**Dependencies:** Phase 0 + Phase 1. Steps 2.6-2.7 are the highest-effort change (atomic update of 66 call sites).
**Risk:** Medium. Step 2.6 is a breaking change within the codebase (compile-time errors, not runtime). Steps 2.1-2.5 change gate behavior for edge cases.

### Phase 3: Epistemic Decision Engine + Pipeline Confidence

| # | Change | File(s) | Depends on | Test strategy |
|---|--------|---------|------------|---------------|
| 3.1 | Implement `computeAggregateConfidence()` (weighted harmonic mean) | `src/gate/epistemic-decision.ts` | 0.9 | Unit tests with worked examples from DE |
| 3.2 | Implement `deriveEpistemicDecision()` | `src/gate/epistemic-decision.ts` | 3.1 | Test all 4 decision paths with scenario data |
| 3.3 | Wire `EpistemicGateVerdict` into gate pipeline | `src/gate/gate.ts` | 3.2, 2.3 | Integration test: gate returns epistemic fields |
| 3.4 | Backward-compat mapping: `toClassicDecision()` | `src/gate/gate.ts` | 3.3 | Test: "allow-with-caveats" maps to "allow", "uncertain" maps to "block" |
| 3.5 | Wire pipeline confidence computation into core-loop | `src/orchestrator/core-loop.ts` | 0.8, 3.3 | Integration test with reference values |
| 3.6 | Pipeline confidence drives retry/escalation | `src/orchestrator/core-loop.ts` | 3.5 | Test: "uncertain" escalates without consuming retry |
| 3.7 | Implement `RetryBudget` with generation retries + verification escalations | `src/orchestrator/core-loop.ts` | 3.6 | Test: re-verify path does not consume generation retry |
| 3.8 | Wire prediction into decomposer (optional `prediction?` param) | `src/orchestrator/task-decomposer.ts` | 3.5 | Test: low metaConfidence triggers granularity guidance |
| 3.9 | Populate working memory uncertainties from prediction | `src/orchestrator/core-loop.ts` | 3.5 | Test: `addUncertainty()` called with prediction data |
| 3.10 | Store `pipelineConfidence` + `confidenceDecision` in `ExecutionTrace` | `src/orchestrator/core-loop.ts`, `src/db/trace-store.ts` | 3.5 | Test: trace includes pipeline data |
| 3.11 | SQLite schema: add `pipeline_confidence_composite`, `confidence_decision` columns | `src/db/trace-store.ts` | 3.10 | Migration test |
| 3.12 | Oracle enrichment: oracles emit `opinion` alongside `confidence` | All oracle runners | 0.7 | Per-oracle: opinion.projectedProbability ~ confidence |
| 3.13 | Implement post-hoc oracle accuracy tracking | `src/db/oracle-accuracy-store.ts` (NEW), `src/bus/` | 0.10 | Accuracy store CRUD tests |
| 3.14 | Remove circular `updateOracleAccuracy()` | `src/gate/gate.ts` | 3.13 | Test: old function removed; accuracy from store |
| 3.15 | Wire retrospective accuracy into conflict resolver | `src/gate/conflict-resolver.ts` | 3.13, 3.14 | Test: Step 4 uses post-hoc accuracy |

**Dependencies:** Phase 0 + Phase 1 + Phase 2. Steps 3.1-3.4 (gate) and 3.5-3.11 (pipeline) can proceed in parallel. Steps 3.12-3.15 (SL + accuracy) can proceed in parallel with both.
**Risk:** Medium-high. This is the largest phase. Core loop changes (3.5-3.9) need careful integration testing.

### Phase 4: SL Fusion (replaces heuristic aggregation)

| # | Change | File(s) | Depends on | Test strategy |
|---|--------|---------|------------|---------------|
| 4.1 | Implement SL fusion operators (cumulative, averaging, weighted) | `src/core/subjective-opinion.ts` | 0.1 | Unit tests: fusion invariants (b+d+u=1, u reduces for CF) |
| 4.2 | Implement conflict constant K computation | `src/core/subjective-opinion.ts` | 4.1 | Test: K=0 for agreeing, K>0.5 for contradicting |
| 4.3 | Add source independence declarations to oracle registry | `src/oracle/registry.ts` | None | Test: dependency overlap calculation |
| 4.4 | Implement fusion operator selection algorithm | `src/core/subjective-opinion.ts` | 4.1, 4.3 | Test: AST+Type=averaging, AST+Test=cumulative |
| 4.5 | Implement `fuseAll()` for N-oracle fusion | `src/core/subjective-opinion.ts` | 4.1, 4.4 | Test: multi-oracle fusion with reference values |
| 4.6 | Implement `clampOpinionByTier()` (preserve uncertainty) | `src/core/subjective-opinion.ts` | 0.1 | Test: uncertainty never decreases after clamping |
| 4.7 | Implement temporal decay for opinions (u grows over time) | `src/core/subjective-opinion.ts` | 0.1 | Test: decayed opinion converges to vacuous |
| 4.8 | Refactor conflict resolver: K replaces heuristic Steps 3-5 | `src/gate/conflict-resolver.ts` | 4.2, 4.5, 3.12 | Backtest: SL decisions match or improve on heuristic for historical traces |
| 4.9 | Gate aggregate uses `projectedProbability(fusedOpinion)` | `src/gate/gate.ts` | 4.8 | Integration test: end-to-end gate with SL |
| 4.10 | Quality score uses projected probability from fused opinions | `src/gate/quality-score.ts` | 4.9 | Test: quality score reflects SL-derived confidence |

**Dependencies:** Phase 3 (specifically 3.12: oracle opinion enrichment). Steps 4.1-4.7 are pure library code and can start in Phase 0 timeframe.
**Risk:** High. This replaces the core conflict resolution logic. Requires backtesting against real trace data before deployment (4.8).

### Phase 5: ECP v2 Protocol Evolution (future)

| # | Change | File(s) | Depends on |
|---|--------|---------|------------|
| 5.1 | Add `opinion` to `ECPDataPartSchema` (optional field) | `src/a2a/ecp-data-part.ts` | 0.1 |
| 5.2 | Validate `confidence ~ projectedProbability(opinion)` on wire ingestion | `src/a2a/` | 5.1 |
| 5.3 | Peer trust clamping for remote opinions (uncertainty floor) | `src/oracle/tier-clamp.ts` | 4.6, 5.1 |
| 5.4 | Pipeline confidence in ECP messages | `src/a2a/` | 3.10, 5.1 |
| 5.5 | Base rate calibration via prediction error (EMA, >= 30 verdicts) | `src/core/subjective-opinion.ts` | 4.x, 3.13 |

**Dependencies:** Phase 4 complete. Protocol changes require cross-instance coordination.
**Risk:** Medium. Wire format changes need versioning care. `ecp_version` stays at 1 while opinion is optional.

---

## 5. Critical Path: Top 5 Minimum Viable Changes

If we could only implement 5 changes to close the most critical epistemic gaps:

| Priority | Change | Deficit closed | Files | Effort |
|----------|--------|---------------|-------|--------|
| **1** | `buildVerdict()` requires explicit `confidence` + `type` (2.6-2.7) | C1: Confidence laundering | `src/core/index.ts`, all oracle verifiers | Medium -- 66 call sites, but mechanical |
| **2** | Zero-oracle compliance = NaN + `unverified: true` (1.3-1.4) | C3: Absence as evidence | `src/gate/quality-score.ts`, consumers | Low |
| **3** | Test/lint oracle abstention for missing infrastructure (2.1-2.5) | C3: Absence as evidence | `src/oracle/test/`, `src/oracle/lint/`, `src/gate/gate.ts` | Medium |
| **4** | Unknown tier default = "heuristic" not "deterministic" (1.1-1.2) | A5 violation | `src/oracle/tier-clamp.ts`, `src/gate/conflict-resolver.ts`, `src/gate/quality-score.ts` | Low |
| **5** | World Graph facts use `min(oracle.confidence)` not 1.0 (1.5) | M4: WG confidence inflation | `src/orchestrator/core-loop.ts` | Low |

These 5 changes close C1, C3, M4, and the A5 tier default violation -- 3 of the 4 critical deficits and 1 moderate deficit. C4 (circular accuracy) requires the post-hoc accuracy store which has higher effort but can follow immediately.

---

## 6. Cross-Cutting Concerns

### 6.1 Performance Budget

| Component | Overhead | Within budget? |
|-----------|----------|----------------|
| SL opinion helpers (fromScalar, projectedProbability) | < 1 us per call | Yes |
| SL fusion for 5 oracles (Phase 4) | ~ 36 us total | Yes (L1 budget: 2s) |
| Pipeline confidence computation | ~ 2-10 ms (arithmetic only) | Yes (< 0.01% of L1 budget) |
| Epistemic decision logic | < 1 ms | Yes |
| Post-hoc accuracy query (SQLite) | ~ 1-5 ms | Yes (async, not in hot path) |
| Re-verification at higher level | 500ms - 10s (oracle execution) | Within routing level budgets |
| **Total added latency (Phase 3)** | **< 15 ms** (excluding re-verify oracle calls) | **Yes** |

L0 reflex path (< 100ms) is explicitly exempt from all new computation. No pipeline confidence, no SL fusion, no epistemic decision -- pure hash match.

### 6.2 Observability (merged from all 4 designs)

See Section 7 (Event Catalog) for the full list.

### 6.3 Testing Strategy

**Principle: Each phase has a gating test suite that must pass before proceeding.**

| Phase | Test type | Coverage target |
|-------|-----------|-----------------|
| 0 | Unit tests for new types + helpers | 100% of new functions |
| 1 | Regression tests for changed defaults | All existing tests pass + new threshold tests |
| 2 | Integration tests for oracle abstention flow | Gate handles all abstention combinations |
| 3 | End-to-end tests for epistemic decision pipeline | Scenario tests from DE (ss8) + PC (ss11) |
| 4 | Backtest: SL fusion vs heuristic on historical traces | SL produces equivalent or better decisions on 95%+ of historical data |

**Key test files (new):**
- `tests/core/subjective-opinion.test.ts` -- All SL helper functions + invariants
- `tests/gate/epistemic-decision.test.ts` -- Decision logic + threshold tests
- `tests/gate/oracle-abstention.test.ts` -- Abstention handling in gate pipeline
- `tests/orchestrator/pipeline-confidence.test.ts` -- Composite formula + reference values
- `tests/db/oracle-accuracy-store.test.ts` -- Post-hoc accuracy CRUD + query

### 6.4 A3 Compliance Verification

Every decision path in the unified design is rule-based:

| Decision | Mechanism | LLM involvement |
|----------|-----------|-----------------|
| Gate decision (4-state) | Threshold comparison on aggregate confidence | None |
| Retry vs escalate | Threshold comparison on pipeline composite | None |
| Fusion operator selection | Jaccard overlap on dependency sets | None |
| Conflict detection | K constant > 0.5 | None |
| Tier clamping | Table lookup | None |
| Base rate resolution | Priority chain (verdict > registry > tier > 0.5) | None |
| Re-verify trigger | Composite below ADEQUATE threshold | None |

**The only LLM involvement is in generation (Step 4) and critic evaluation (Step 5b), which are explicitly NOT governance decisions.** All routing, retry, escalation, and commit decisions are deterministic. A3 is fully satisfied.

---

## 7. Event Catalog

All new events merged from the 4 designs:

```typescript
interface VinyanBusEvents {
  // ... existing events unchanged ...

  // Gate epistemic events (from DE)
  'gate:epistemic_decision': {
    taskId: string;
    decision: EpistemicGateDecision;
    aggregateConfidence: number;
    oracleCount: number;
    abstentionCount: number;
    caveats: string[];
  };

  'gate:oracle_abstention': {
    taskId: string;
    oracleName: string;
    reason: AbstentionReason;
  };

  'gate:high_conflict': {
    taskId: string;
    conflictK: number;
    pairs: Array<{ a: string; b: string; k: number }>;
  };

  // Pipeline events (from PC)
  'pipeline:confidence_computed': {
    taskId: string;
    pipelineConfidence: PipelineConfidence;
    routingLevel: RoutingLevel;
    iteration: number;
  };

  'pipeline:low_confidence_success': {
    taskId: string;
    pipelineConfidence: PipelineConfidence;
    routingLevel: RoutingLevel;
    shadowPriority: 'normal' | 'high';
  };

  'pipeline:confidence_escalation': {
    taskId: string;
    fromLevel: RoutingLevel;
    toLevel: RoutingLevel;
    compositeConfidence: number;
    weakestStep: string;
    weakestStepConfidence: number;
  };

  'pipeline:confidence_refuse': {
    taskId: string;
    compositeConfidence: number;
    formula: string;
    routingLevel: RoutingLevel;
  };

  'pipeline:re_verify': {
    taskId: string;
    originalConfidence: number;
    additionalOracles: string[];
    routingLevel: RoutingLevel;
  };

  // Threshold crossing events (from DE)
  'confidence:threshold_crossed': {
    taskId: string;
    threshold: string;
    value: number;
    direction: 'above' | 'below';
  };

  // Retry budget events (from DE + PC)
  'task:re-verify': {
    taskId: string;
    reason: string;
    aggregateConfidence: number;
    targetLevel: RoutingLevel;
  };

  'task:escalate': {
    taskId: string;
    fromLevel: RoutingLevel;
    toLevel: RoutingLevel;
    reason: string;
  };

  // Accuracy events (from OI)
  'oracle:accuracy_resolved': {
    oracleName: string;
    gateRunId: string;
    outcome: VerdictOutcome;
    source: string;
  };
}
```

**Prometheus metrics** (from PC):

```
vinyan_pipeline_confidence_decisions_total{action="allow|re_verify|retry|escalate|refuse"}
vinyan_pipeline_confidence_composite{routing_level="0|1|2|3"}
vinyan_pipeline_confidence_avg{task_type_signature="..."}
vinyan_pipeline_low_confidence_success_total{routing_level="0|1|2|3"}
vinyan_gate_epistemic_decision_total{decision="allow|allow_with_caveats|uncertain|block"}
vinyan_oracle_abstention_total{oracle="...",reason="..."}
vinyan_oracle_accuracy{oracle="...",window="7d|30d"}
```

---

## 8. Open Questions

### Must Answer Before Implementation

| # | Question | Source | Impact |
|---|----------|--------|--------|
| **OQ1** | Harmonic mean too aggressive at L1? | DE Q1 | If L1 has many "uncertain" decisions that should be "allow", switch to geometric for L1. Start with harmonic, measure false-uncertain rate after 100 traces. |
| **OQ2** | Re-verification code path architecture? | DE Q2 | Need `verifyAtLevel(mutations, level, deps)` function decoupled from generate-verify loop. Must be designed before Phase 3.6. |
| **OQ3** | NaN composite handling in all consumers? | OI Q4 | Audit all callers of `qualityScore.composite` before Phase 1.3. Guard with `Number.isNaN()` checks. |

### Can Defer to Implementation

| # | Question | Source | When to answer |
|---|----------|--------|----------------|
| OQ4 | Dynamic threshold adjustment via Evolution Engine? | DE Q3 | Phase 4+ (after 1000+ traces) |
| OQ5 | Should pipeline confidence influence model selection? | PC Q1 | Phase 4+ (keep model selection in routing) |
| OQ6 | Adaptive pipeline weights per task type? | PC Q3 | Phase 5+ (requires significant trace data) |
| OQ7 | SL base rate adaptation rate (EMA alpha)? | SL Q1 | Phase 4 (start alpha=0.05, tune later) |
| OQ8 | Cross-instance opinion trust and uncertainty flooring? | SL Q2 | Phase 5 (A2A protocol) |
| OQ9 | Multi-hypothesis (multinomial) opinions? | SL Q3 | Phase 5+ (binary frame sufficient now) |
| OQ10 | Fusion order floating-point normalization? | SL Q4 | Phase 4 (normalize after each step) |
| OQ11 | SL temporal decay: belief decay or uncertainty growth? | SL Q5 | Phase 4 (uncertainty growth is more honest) |
| OQ12 | SL gate allow threshold per routing level? | SL Q6 | Phase 4 (start at 0.5, tune per level) |
| OQ13 | Accuracy store bootstrap period behavior? | OI Q5 | Phase 3 (skip Step 4 when <10 verdicts -- existing behavior) |
| OQ14 | L0 and abstention protocol? | OI Q6 | Phase 2 (L0 is separate code path, no abstentions) |
| OQ15 | Pipeline confidence in ECP A2A messages? | PC Q5 | Phase 5 |
| OQ16 | Pipeline confidence vs QualityScore reconciliation? | PC Q6 | None needed -- orthogonal dimensions |
| OQ17 | Retroactive accuracy for abstentions? | OI Q3 | Track as coverage metric, not accuracy |

---

## 9. References

### Design Documents (inputs to this synthesis)
- [design-decision-engine.md](./design-decision-engine.md) -- Epistemic Decision Engine: 4-state GateDecision, confidence thresholds, aggregate formula, retry/escalation policy
- [design-subjective-logic.md](./design-subjective-logic.md) -- Subjective Logic Protocol: SubjectiveOpinion type, fusion operators, clamping, wire format, migration path
- [design-pipeline-confidence.md](./design-pipeline-confidence.md) -- Pipeline Uncertainty Propagation: PipelineConfidence type, step-by-step flow, composite formula, cold start behavior
- [design-oracle-integrity.md](./design-oracle-integrity.md) -- Oracle Integrity: buildVerdict redesign, abstention protocol, post-hoc accuracy tracking, per-oracle confidence standards

### Research Documents (foundations)
- [ehd-synthesis.md](./ehd-synthesis.md) -- Cross-disciplinary research synthesis (philosophy, AI/ML, formal methods, codebase audit)
- [epistemic-humility-deficit.md](./epistemic-humility-deficit.md) -- Philosophical foundations
- [ehd-technical-landscape.md](./ehd-technical-landscape.md) -- AI/ML technical landscape
- [formal-uncertainty-frameworks.md](./formal-uncertainty-frameworks.md) -- Formal frameworks (DST, SL, BFT)

### Architecture Documents (constraints)
- `docs/architecture/decisions.md` -- Architectural decisions D1-D8
- `docs/spec/tdd.md` -- Interface contracts and schemas
- `docs/spec/ecp-spec.md` ss4.2 -- BeliefInterval extension specification
