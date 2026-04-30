# ECP System Design Debate — Synthesis

> **Document boundary**: This document owns the system design review verdict for ECP evolution.
> For strategic debate (should we? what's missing?), see [ecp-debate-synthesis.md](ecp-debate-synthesis.md).
> For the design doc itself, see [../archive/ecp-system-design.md](../archive/ecp-system-design.md). (Archived: ECP v2 brainstorm; not implemented. Authority for ECP wire protocol is `spec/ecp-spec.md`.)

---

## Executive Verdict

**🟢 CONDITIONAL GO** — Design is architecturally sound, axiom-grounded, and performance-safe. Five data flow dead ends must be wired before production. No contradictions found across 4 independent expert reviews.

| Dimension | Status | Rationale |
|-----------|--------|-----------|
| Architecture | ✅ Sound | Axioms respected; wiring gaps are implementation, not design flaws |
| Data Flow | 🟡 Incomplete | 5 dead ends — all fixable in Phase B (4-5 days) |
| Performance | ✅ Safe | <0.2% overhead across all routing levels; no scaling concerns |
| Migration | 🟡 Conditional | External oracle compatibility requires feature flag; phased rollout mitigates |
| Autonomy Foundation | 🟡 60% ready | v2 provides structural framework; learning algorithms are Phase 7's gap |

---

## Review Panel

| Role | Focus | Key Finding |
|------|-------|-------------|
| **Architecture Purist** | Boundaries, DI, testability | `enrichVerdictWithRegistryData()` designed but never wired; quality-score ↔ fusion execution order ambiguous |
| **Data Flow Engineer** | Value flow, transformation correctness | 5 dead ends where v2 fields are defined but never produced/consumed; `fromScalar()` creates dogmatic opinions (u=0) |
| **Migration Safety Expert** | Backward compat, rollback, deployment | CONDITIONAL GO; 3-phase deployment with feature flags; ~15-20 new tests needed |
| **Runtime Engineer** | Latency, memory, scalability | NEGLIGIBLE impact; +5-130µs per verdict; +130 bytes JSON; no complexity class change |
| **Integration Moderator** | Convergence, contradictions, fix list | Zero contradictions; 15 fixes across 3 phases; 6-7 day critical path |
| **Autonomy Moderator** | Phase 7 readiness, 8 autonomy metrics | 3 critical metrics blocked by dead ends; fromScalar() fix recommended in v2 |

---

## 1. Convergence Map

### Unanimous Agreements (100% confidence)

- `tier_reliability` is orphaned — no population path specified in runner.ts
- Quality-score ↔ fusion execution order is ambiguous — needs explicit pipeline split
- `fusedOpinion` is wired into data model but never consumed by core-loop
- `confidence_source` lacks routing governance enforcement (A3 violation)
- Performance impact is negligible (<0.2% overhead across all L-levels)
- Design is feasible — no architectural show-stoppers
- Phased deployment with feature flags is the safe approach

### Zero Contradictions

What appears as conflict is actually stratified concerns at different abstraction layers. All 4 agents arrived at overlapping, mutually-reinforcing conclusions independently.

---

## 2. The 5 Dead Ends

Schema-defined fields that are never produced or consumed. These are not hygiene issues — they **sever feedback loops** required for autonomous operation.

| # | Dead End | Producer Gap | Consumer Gap | Autonomy Impact |
|---|----------|-------------|--------------|-----------------|
| 1 | `tier_reliability` → conflict resolver | Runner never populates; uses oracle name string | Conflict resolver uses `getTierPriority()` from name, not reliability score | **CRITICAL** — routing can't weight evidence quality |
| 2 | `engine_certainty` → SelfModel calibration | Persisted to trace | SelfModel.calibrate() never reads it | **HIGH** — calibration loop blind to engine confidence |
| 3 | `confidence_source` → routing governance | Field exists in schema | No governance filter; LLM verdicts flow equally (A3 violation) | **CRITICAL** — unvetted source can flip routing |
| 4 | `fusedOpinion` → pipeline confidence | Computed in GateVerdict | `computePipelineConfidence()` takes scalars only | **CRITICAL** — no predicted vs actual comparison |
| 5 | `belief_interval` → ResolvedGateResult | Computed in fusion | Field doesn't exist in interface | **HIGH** — SL-based routing has no credibility interval |

**Decision**: All 5 must be fixed in v2. Without them, v2 becomes write-only infrastructure — opinions collected but never used. Phase 7 has no learning signal.

---

## 3. Additional Critical Issues

### fromScalar() Information Fabrication

`fromScalar()` creates opinions with `u=0` (zero uncertainty) regardless of evidence quality. Oracle confidence 0.95 from 50 tests and 0.95 from 1 test both get `u=0`. This violates A2 (First-Class Uncertainty).

**Decision**: Fix in v2 (minimal scope).
- Change: `fromScalar(value, default_uncertainty?)` → default `u=0.3` if not provided
- Cost: ~2-3 hours + 2 tests
- Rationale: A2 is foundational. Deferring corrupts Phase 7's calibration baseline.

### Floating-Point Precision Inconsistency

Zod opinion validation uses `0.001` tolerance; internal `isValid()` uses `1e-9` (1,000,000× stricter). Opinions passing Zod silently fail internal checks.

**Fix**: Define `TOLERANCE_THRESHOLD = 1e-6` constant; use everywhere.

### Circular Quality-Score / Fusion Dependency

Design says fusedConfidence overrides architecturalCompliance in quality-score, but execution order is unspecified.

**Fix**: Split into explicit two-step pipeline:
1. `computeFromVerdicts()` — aggregate oracle verdicts → base quality
2. `recalibrateWithFusion()` — if fusedOpinion available, reweight (optional second pass)

### Zero-Oracle Inflation

Quality score returns 1.0 (dogmatic confidence) when zero oracles run. Should return 0.5 (uncertain) per A2.

---

## 4. Definitive Fix List

### Phase A: Schema & Data Model (1-2 days, zero risk)

| # | Fix | Effort |
|---|-----|--------|
| A1 | Add `GUARDRAIL_BLOCKED` to OracleErrorCode Zod enum | 0.5h |
| A2 | Make `confidence_source` explicit enum: `'ORACLE' \| 'FUSION' \| 'UNKNOWN'` | 0.25h |
| A3 | Add `tier_reliability?: number` to OracleVerdict schema | 0.25h |
| A4 | Add `belief_interval?: [number, number]` to ResolvedGateResult | 0.5h |

### Phase B: Execution Wiring & Data Flow (4-5 days, blocks core functionality)

| # | Fix | Effort | Blocker |
|---|-----|--------|---------|
| B1 | Implement `enrichVerdictWithRegistryData()` | 2h | YES — blocks B2 |
| B2 | Wire enrichment call in runner.ts after each verdict | 1h | Depends on B1 |
| B3 | Split quality-score: `computeFromVerdicts()` + `recalibrateWithFusion()` | 2h | YES — pipeline clarity |
| B4 | Add `isGovernanceEligible(verdict)` filter for routing | 1h | Independent |
| B5 | Implement `clampOpinionFull(opinion, bounds)` | 0.5h | Independent |
| B6 | Fix zero-oracle quality default: 1.0 → 0.5 | 0.5h | Independent |

### Phase C: Quality, Testing & Safety (5-7 days, parallel with B)

| # | Fix | Effort |
|---|-----|--------|
| C1 | Fix `fromScalar()` — add default uncertainty parameter | 1.5h |
| C2 | Standardize floating-point tolerance constant | 0.25h |
| C3 | Update ~5 existing tests for quality-score changes | 3h |
| C4 | Add A2A peer version negotiation tests | 2h |
| C5 | Implement `ENABLE_ECP_BEHAVIORS` feature flag | 1h |

**Critical path**: 6-7 days (A → B sequential; C parallel with B)

---

## 5. Design Doc Amendments Required

### New Sections for `ecp-system-design.md`

1. **§3.2a Data Pipeline Execution Order** — Specify `computeFromVerdicts()` → `[IF fusion]` → `recalibrateWithFusion()` sequence with diagram
2. **§3.3a Tier Reliability Population Path** — Runner enrichment pipeline pseudocode showing explicit `enrichVerdictWithRegistryData()` call site
3. **§3.4a Governance Evidence Checks** — `confidence_source` filtering rules referencing A3
4. **§3.5a Fusion Opinion Consumption** — Where fusedOpinion enters pipeline via `recalibrateWithFusion()`

### Revised Sections

1. **§2.3 OracleVerdict Schema** — Add `tier_reliability`, `confidence_source` enum; clarify `belief_interval` is output of fusion
2. **§2.7 ResolvedGateResult** — Add `belief_interval?: [number, number]`
3. **§5.2 Known Issues** — Document zero-oracle quality default change (1.0 → 0.5)
4. **§6 Deployment Strategy** — Replace with 3-phase plan: Schema (day 1) → Behavioral canary (days 2-5) → Full rollout (day 7+)

---

## 6. Autonomy Readiness Assessment

### 8 Autonomy Metrics vs v2 Foundation

| # | Metric | v2 Status | Gap to Phase 7 |
|---|--------|-----------|-----------------|
| 1 | Self-Correcting Routing | 🔴 Blocked | Fix 5 dead ends + wire fusedOpinion → pipeline feedback |
| 2 | Graceful Degradation | 🟢 Strong | Document confidence thresholds for escalation triggers |
| 3 | Drift Recovery | 🔴 Blocked | Design feedback loop: actual outcome → opinionChain → EMA mismatch |
| 4 | Evidential Soundness (A1-A4) | 🟡 Mixed | Fix fromScalar() u=0; resolve Type-Zod sync debt; add compliance tests |
| 5 | No Silent Regressions | 🔴 Blocked | Define quality thresholds + confidence source governance |
| 6 | Config Robustness | 🟡 Moderate | Document trace retention policy; add config validation gates |
| 7 | Bounded Miscalibration | ⬜ Deferred | Phase 7: implement EMA bounds + calibration loop |
| 8 | Operator-Free Operation | 🟢 Strong | Finalize task decomposer contract + worker capability routing |

**v2 provides 60% of Phase 7's foundation.** The missing 40% is algorithmic (learning/calibration) and operational (monitoring/alerting), not architectural.

### What Phase 7 Can Build Directly on v2

- **Drift Recovery** — opinionChain history ready; Phase 7 adds comparison algorithm
- **Auto-Learning Routing** — fusedOpinion framework ready; Phase 7 adds EMA learning
- **Graceful Degradation** — confidence tiers defined; Phase 7 adds trigger rules
- **Silent Regression Detection** — quality_score + governance ready; Phase 7 adds anomaly detection

### What Phase 7 Still Needs (New Infrastructure)

- Calibration algorithm (EMA loop, bounds enforcement, cold-start bootstrap)
- Operator-free monitoring (auto-alerting on miscalibration threshold)
- Worker capability routing (ReasoningEngineRegistry-to-tier mapping rules)
- Feedback loop closure (outcome capture, latency tracking, confidence→outcome correlation)

---

## 7. Deployment Strategy

### 3-Phase Rollout

| Phase | Scope | Duration | Risk |
|-------|-------|----------|------|
| **1. Schema Migration** | Zod updates, new fields, no behavior change | Day 1 | Zero |
| **2. Behavioral Canary** | Feature flag ON for 10% of tasks; monitor error rate | Days 2-5 | Low (flag = instant rollback) |
| **3. Full Rollout** | 100% after 7-day stability window | Day 7+ | Mitigated |

**Rollback plan**: Disable feature flag → revert Zod defaults to 1.0 in adapter → maintain schema for observability.

---

## 8. Implementation Prioritization

### Tier 0 — Must Fix in v2 (blocks production)

- Wire 5 dead ends (enrichment, governance filter, fusion consumption, belief interval)
- Fix fromScalar() default uncertainty
- Implement quality-score pipeline split
- Add feature flag for behavioral changes

### Tier 1 — Should Document Before v2 Ships

- Data pipeline execution order specification
- Confidence source governance matrix
- Drift detection mechanism design (what v2 must measure for Phase 7)
- Trace retention policy

### Tier 2 — Phase 7 Launch Readiness Gate

- Axiom compliance audit checklist
- Config change safety policy
- Feedback loop architecture document
- Oracle SDK compatibility matrix

**Ship with Tier 0 + Tier 1. Tier 2 is Phase 7's launch readiness gate.**

---

## 9. Pre-Implementation Checklist

```
PHASE A — START IMMEDIATELY (1-2 days):
  [ ] A1: Add GUARDRAIL_BLOCKED to OracleErrorCode enum
  [ ] A2: Add confidence_source explicit enum
  [ ] A3: Add tier_reliability to OracleVerdict schema
  [ ] A4: Add belief_interval to ResolvedGateResult

PHASE B — AFTER A (4-5 days):
  [ ] B1: Implement enrichVerdictWithRegistryData()
  [ ] B2: Wire enrichment in runner.ts
  [ ] B3: Split quality-score pipeline
  [ ] B4: Add isGovernanceEligible() filter
  [ ] B5: Implement clampOpinionFull()
  [ ] B6: Fix zero-oracle quality default

PHASE C — PARALLEL WITH B (5-7 days):
  [ ] C1: Fix fromScalar() uncertainty parameter
  [ ] C2: Standardize floating-point tolerance
  [ ] C3: Update existing tests
  [ ] C4: A2A version negotiation tests
  [ ] C5: Implement ENABLE_ECP_BEHAVIORS feature flag

DEPLOY:
  [ ] Schema migration (day 1)
  [ ] Canary 10% (day 2-5, flag OFF by default)
  [ ] Monitor 7 days
  [ ] Full rollout + flag ON
```
