# ForwardPredictor — Implementation Plan

> **Status:** Implementation Plan — Ready for Execution
> **Date:** 2026-04-03
> **Authors:** Expert Agent Team (Foundation, Prediction Engine, Integration)
> **Source:** [forward-predictor-architecture.md](../architecture/forward-predictor-architecture.md)
> **Axioms:** A1 (Epistemic Separation), A3 (Deterministic Governance), A7 (Prediction Error as Learning)

> **Document boundary**: This document owns the **step-by-step implementation plan** for the ForwardPredictor subsystem.
> For architecture, algorithms, and design rationale, see [forward-predictor-architecture.md](../architecture/forward-predictor-architecture.md).
> For type definitions, see [world-model.md](world-model.md) and `src/orchestrator/forward-predictor-types.ts`.
> For project-level roadmap, see [implementation-plan.md](implementation-plan.md).

---

## 1. Overview

7 phases (FP-A through FP-G), 35 implementation steps. Each phase has explicit prerequisites, verification gates, and estimated scope.

**Dependency graph:**

```
FP-A: Foundation ──────────┬──→ FP-C: Core Predictor ──┬──→ FP-E: Core Loop Wiring ──→ FP-F: Calibration V2 ──→ FP-G: Counterfactual
                           │                            │
FP-B: Causal Edges ────────┘──→ FP-D: Causal Predictor ┘
```

**Cross-reference: Project Phase ↔ ForwardPredictor Phase**

| Project Phase | FP Phases | Scope |
|---------------|-----------|-------|
| Phase 1E onwards | FP-A, FP-B, FP-C, FP-D | Foundation + core prediction |
| Phase 2 onwards | FP-E, FP-F | Core loop wiring + calibration v2 |
| Phase 3+ | FP-G | Advanced counterfactual planning |

---

## 2. Reuse Patterns

Before implementing, follow these existing codebase patterns:

| Pattern | Source | Used By |
|---------|--------|---------|
| SQLite store (constructor, migrations, CRUD, prepared statements) | `src/db/trace-store.ts`, `src/db/pattern-store.ts` | FP-A (PredictionLedger) |
| Safe migrations (PRAGMA table_info before ALTER TABLE) | `src/db/trace-schema.ts` | FP-A, FP-B (schema) |
| Zod config schema with defaults | `src/config/schema.ts` (EvolutionConfigSchema) | FP-A (ForwardPredictorConfig) |
| EventBus emit/listen | `src/core/event-bus.ts`, `src/bus/` listeners | FP-E (prediction events) |
| Optional deps + graceful degradation | `src/orchestrator/core-loop.ts` (forwardPredictor?) | FP-E (all integration points) |
| Data gates (feature activation by trace count) | `src/orchestrator/data-gate.ts` | FP-A (PredictionTierSelector) |

---

## FP-A: Foundation

### Prerequisites
- SQLite DB operational (`bun:sqlite`)
- Existing `forward-predictor-types.ts` with core types

### Steps

| # | File | What | Risk | Depends |
|---|------|------|------|---------|
| A.1 | `src/db/prediction-ledger-schema.ts` (NEW) | SQLite schema: `prediction_ledger` table (predictionId, taskId, basis, testOutcome JSON, blastRadius JSON, qualityScore JSON, confidence, timestamp), `prediction_outcomes` table (predictionId FK, actualTestResult, actualBlastRadius, actualQuality, actualDuration, brierScore), `file_outcome_stats` view (per-file success rate, avg quality, sample count). Safe migrations using PRAGMA table_info. | 🟢 | — |
| A.2 | `src/db/prediction-ledger.ts` (NEW) | PredictionLedger class: `recordPrediction(pred)`, `recordOutcome(outcome, brierScore)`, `getPercentiles(taskType, percentiles[])` → `{lo, mid, hi}`, `getFileOutcomeStats(files[])` → `FileOutcomeStat[]`, `getTraceCount()`, `getRecentBrierScores(window)`. Follow TraceStore pattern: constructor takes Database, runs migrations, uses prepared statements with `$named` params. | 🟢 | A.1 |
| A.3 | `src/orchestrator/forward-predictor-types.ts` (MODIFY) | Add types: `PredictionRecord` (DB row shape), `FileOutcomeStat` (filePath, successCount, failCount, samples, avgQuality), `StatisticalEnhancement` (blended TestOutcomeDistribution + PredictionDistributions + confidence), `CausalRiskAnalysis` (adjustedPPass, riskFiles[], aggregateRisk). | 🟢 | — |
| A.4 | `src/gate/prediction-tier-selector.ts` (NEW) | `PredictionTierSelectorImpl`: `select(traceCount, edgeCount, miscalibrationFlag)` → `'heuristic' \| 'statistical' \| 'causal'`. Logic: heuristic always; statistical if traces ≥ 100; causal if traces ≥ 100 AND edges ≥ 50 AND !miscalibrationFlag. Thresholds from config. | 🟢 | — |
| A.5 | `src/config/schema.ts` (MODIFY) | Add `ForwardPredictorConfigSchema` (Zod): `enabled`, `tiers.statistical.minTraces`, `tiers.causal.{minTraces, minEdges}`, `budgets.{predictionTimeoutMs, maxAlternativePlans}`, `calibration.{temporalDecayHalfLifeDays, miscalibrationThreshold, miscalibrationWindow}`. Merge into main VinyanConfigSchema. | 🟢 | — |

### Tests

| File | Key Scenarios |
|------|---------------|
| `tests/db/prediction-ledger.test.ts` | Idempotent migrations, recordPrediction/recordOutcome round-trip, getPercentiles accuracy (known data → known percentiles), getFileOutcomeStats aggregation, empty DB returns defaults |
| `tests/gate/prediction-tier-selector.test.ts` | Tier selection matrix: 0 traces → heuristic, 100 traces → statistical, 100+50 → causal, miscalibration flag → drop to statistical |

### Verification Gate

- ✅ Schema migrates 2× without errors (idempotent)
- ✅ Percentile queries return correct [lo, mid, hi] on known data
- ✅ TierSelector logic matches architecture §3.1
- ✅ Config Zod schema validates + provides defaults
- ✅ `bun run test` passes, `bun run check` clean

---

## FP-B: Causal Edges

### Prerequisites
- FP-A complete (PredictionLedger available)
- Existing dep-analyzer in `src/oracle/dep/`
- Existing WorldGraph with fact storage

### Steps

| # | File | What | Risk | Depends |
|---|------|------|------|---------|
| B.1 | `src/world-graph/schema.ts` (MODIFY) | Add `causal_edges` table if not exists: (fromFile, fromSymbol, toFile, toSymbol, edgeType, confidence, source, createdAt). Index on (fromFile), (toFile), (edgeType). | 🟢 | — |
| B.2 | `src/world-graph/world-graph.ts` (MODIFY) | Add methods: `storeCausalEdge(edge: CausalEdge)`, `storeCausalEdges(edges: CausalEdge[])` (batch INSERT OR REPLACE), `getDependents(filePath, maxDepth?)` → `CausalEdge[]` (single hop), `getCausalEdgeCount()`. Store edges with SHA-256 hash binding per A4. | 🟡 | B.1 |
| B.3 | `src/oracle/dep/causal-edge-extractor.ts` (NEW) | CausalEdgeExtractorImpl: extends dep-analyzer's AST capabilities. Extract semantic edges: `extends-class` (class heritage), `implements-interface` (implements clause), `calls-method` (call expressions on imported symbols), `uses-type` (type references), `test-covers` (heuristic: test file → source file mapping by naming convention), `re-exports` (export * / export { } from). Confidence: 1.0 for static analysis, 0.7–0.9 for inferred (test-covers). | 🟡 | — |
| B.4 | `src/orchestrator/perception.ts` (MODIFY) | In `PerceptionAssemblerImpl.assemble()`: if CausalEdgeExtractor available, extract edges for `task.targetFiles` and include in PerceptualHierarchy. Graceful: try/catch, emit event on error, continue without edges. | 🟡 | B.3 |
| B.5 | `src/orchestrator/types.ts` (MODIFY) | Add optional `causalEdges?: CausalEdge[]` to PerceptualHierarchy interface. | 🟢 | — |

### Tests

| File | Key Scenarios |
|------|---------------|
| `tests/world-graph/causal-edges.test.ts` | storeCausalEdge + getDependents round-trip, batch insert, duplicate handling (OR REPLACE), edge count query |
| `tests/oracle/dep/causal-edge-extractor.test.ts` | TypeScript fixtures with known class hierarchies → verify extends/implements/calls-method detection. Test-covers heuristic: `foo.test.ts` → covers `foo.ts`. False positive rate < 5% on fixtures. |
| `tests/orchestrator/perception.test.ts` | With extractor: edges included in perception. Without extractor: no crash, perception still valid. |

### Verification Gate

- ✅ CausalEdgeExtractor identifies extends/implements/calls-method/test-covers/uses-type
- ✅ WorldGraph.getDependents() returns correct single-hop dependents
- ✅ Edges survive DB close/reopen (persistence)
- ✅ PerceptionAssembler gracefully handles missing extractor
- ✅ `bun run test` passes, `bun run check` clean

---

## FP-C: Core Predictor

### Prerequisites
- FP-A complete (PredictionLedger, TierSelector, types)
- FP-B complete for step C.2 only (CausalPredictor needs causal edges from WorldGraph)

### Steps

| # | File | What | Risk | Depends |
|---|------|------|------|---------|
| C.1 | `src/orchestrator/outcome-predictor.ts` (NEW) | OutcomePredictorImpl — Tier 2 statistical engine. `enhance(input, heuristic, fileStats)` → `StatisticalEnhancement`. Algorithm: (1) task-type prior from SelfModel heuristic, (2) file-level likelihood = mean success rate, (3) Bayesian blend: `α × prior + (1-α) × fileEvidence` where `α = exp(-fileCount/50)`, (4) percentile output from PredictionLedger. Confidence: 0.4–0.7. | 🟢 | FP-A |
| C.2 | `src/orchestrator/causal-predictor.ts` (NEW) | CausalPredictorImpl — Tier 3 causal BFS. `computeRisks(input, edges, fileHistories)` → `CausalRiskAnalysis`. Algorithm per architecture §3.4: BFS from target files, max depth 3, FIFO queue, visited set (cycle prevention), pathWeight × CAUSAL_EDGE_WEIGHTS decay, breakProbability = pathWeight × failRate (default 0.1). Aggregate: `P(≥1 break) = 1 - ∏(1 - p_i)`. adjustedPPass = statPPass × (1 - aggregateRisk). Return top 10 risk files. | 🟡 | FP-B |
| C.3 | `src/orchestrator/calibration-engine.ts` (NEW) | CalibrationEngineImpl. `scoreTestOutcome(predicted, actual)` → Brier score (3-class). `scoreContinuous(predicted, actual)` → CRPS (percentile approximation per §4.3). `getCalibrationSummary()` → CalibrationSummary. Initial: compute both MAPE and CRPS in parallel. Brier decomposition: `BS = REL - RES + UNC` (Murphy 1973). | 🟢 | FP-A |
| C.4 | `src/orchestrator/forward-predictor.ts` (NEW) | ForwardPredictorImpl — main orchestrator. Implements `ForwardPredictor` interface. `predictOutcome()`: select tier → T1 always (wrap SelfModel) → T2 if statistical → T3 if causal → persist + emit. `recordOutcome()`: compute Brier, persist, return score. `getCalibrationSummary()`: delegate to CalibrationEngine. SelfModel → OutcomePrediction mapping: `expectedTestResults` (string) → `TestOutcomeDistribution` (pPass/pPartial/pFail from EMA history), `expectedBlastRadius` (number) → `PredictionDistribution` (±30% for lo/hi), `expectedQualityScore` → `PredictionDistribution`. Confidence floors: T1 ≤ 0.3, T2 0.4–0.7, T3 0.6–0.95. | 🟡 | C.1, C.2, C.3, FP-A |
| C.5 | `src/orchestrator/forward-predictor.ts` (ADD) | `blendTier2()` and `applyCausalRisks()` as private methods per architecture §3.2. Normalization: pPass + pPartial + pFail = 1.0 with Math.max(0) + renormalize. | 🟢 | C.4 |

### Tests

| File | Key Scenarios |
|------|---------------|
| `tests/orchestrator/outcome-predictor.test.ts` | Alpha decay: α ≈ 1.0 at n=0, α ≈ 0.5 at n=35. Blend convergence: at n=100, file evidence dominates. Percentile bounds: lo < mid < hi. Distributions sum to 1.0. Empty fileStats: returns prior with low confidence. |
| `tests/orchestrator/causal-predictor.test.ts` | Linear chain A→B→C: correct weight decay. Cycle A→B→C→A: no infinite loop. Diamond A→B,A→C,B→D,C→D: D visited once. Empty graph: aggregateRisk near 0. Top-10 truncation. |
| `tests/orchestrator/calibration-engine.test.ts` | Perfect predictions: Brier = 0.0. Random: Brier ≈ 0.33. CRPS: narrower bounds score better when correct. Decomposition identity: BS = REL - RES + UNC (verify on 100-sample fixture). |
| `tests/orchestrator/forward-predictor.test.ts` | Tier progression: T1 at 0 traces → T2 at 100 → T3 at 100+50. Timeout: >3s returns T1 fallback. Error handling: causal failure → T2 result. Miscalibration flag: forces T2. |

### Verification Gate

- ✅ All tiers complete in < 150ms (P95)
- ✅ Output distributions sum to 1.0 (TestOutcomeDistribution)
- ✅ Brier decomposition identity: BS = REL - RES + UNC
- ✅ CRPS rewards honest uncertainty (narrower correct bounds < wider)
- ✅ ForwardPredictor optional: undefined → core loop skips gracefully
- ✅ `bun run test` passes, `bun run check` clean

---

## FP-D: Causal Predictor

### Prerequisites
- FP-B complete (WorldGraph causal edges, CausalEdgeExtractor)
- FP-C complete (ForwardPredictorImpl, CalibrationEngine)

### Steps

| # | File | What | Risk | Depends |
|---|------|------|------|---------|
| D.1 | `src/orchestrator/calibration-engine.ts` (MODIFY) | Add `updateEdgeWeights(traces)`: Bayesian weight update per §4.4. `weight_new = α × empirical_break_frequency + (1-α) × weight_default`. α = logistic ramp (0 at 50 traces → 1.0 at 200+ traces). Clip to [0.1, 0.99]. Emit `calibration:weights_converged` at 200+. | 🟡 | FP-C |
| D.2 | `src/orchestrator/calibration-engine.ts` (MODIFY) | Add `setTemporalDecayHalfLife(days)` + apply exponential decay `w(t) = e^{-λt}` where `λ = ln2 / halfLifeDays` to prediction scores in calibration queries. Default: 30 days. | 🟢 | FP-C |
| D.3 | `src/sleep-cycle/sleep-cycle.ts` (MODIFY) | Add trace-mined edge inference: if files A and B co-occur in failed traces (Wilson LB ≥ 0.6, ≥ 10 observations) → emit `sleepcycle:causal-edge-mined` event with inferred CausalEdge (source: 'trace-mined', confidence: Wilson LB). | 🟡 | FP-B |
| D.4 | `src/bus/prediction-listeners.ts` (NEW) | Bus listener: on `sleepcycle:causal-edge-mined` → `worldGraph.storeCausalEdge(edge)`. On edge count crossing 50 → emit `datagate:prediction-tier-unlocked`. | 🟢 | D.3 |
| D.5 | `src/orchestrator/forward-predictor.ts` (MODIFY) | Add miscalibration detection: track rolling window of Brier scores. If mean Brier > 0.4 over 20 predictions → set `miscalibrationFlag = true`, emit `prediction:miscalibration`. Auto-recovery: if recent 50 traces show Brier < 0.35 → clear flag, emit `prediction:tier-transition`. Manual recovery: `resetTierState()` method. | 🟡 | FP-C |

### Tests

| File | Key Scenarios |
|------|---------------|
| `tests/orchestrator/calibration-engine-weights.test.ts` | Edge weight Bayesian update: 50 traces → 30% learned. 200+ traces → 100% learned. Clip bounds [0.1, 0.99]. `weights_converged` event emitted. |
| `tests/orchestrator/calibration-engine-decay.test.ts` | Temporal decay: 30-day-old prediction weighted ~50%. 60-day-old ~25%. Fresh = 100%. |
| `tests/sleep-cycle/causal-edge-mining.test.ts` | File co-occurrence: 15 co-failures → Wilson LB > 0.6 → edge emitted. 3 co-failures → below threshold → no edge. |
| `tests/orchestrator/forward-predictor-miscalibration.test.ts` | 20 bad predictions (Brier > 0.4) → flag set, tier drops to T2. 50 good predictions (Brier < 0.35) → auto-recovery to T3. Manual reset works. |

### Verification Gate

- ✅ Edge weight ramp: α increases monotonically with trace count
- ✅ Temporal decay: old predictions weighted less
- ✅ Trace-mined edges have source: 'trace-mined' and confidence < 1.0
- ✅ Miscalibration triggers tier degradation within 20-prediction window
- ✅ Auto-recovery restores T3 after 50 good predictions
- ✅ No breaking changes to FP-A/B/C
- ✅ `bun run test` passes, `bun run check` clean

---

## FP-E: Core Loop Wiring

### Prerequisites
- FP-C + FP-D complete (ForwardPredictorImpl, CalibrationEngine, CausalPredictor)

### Steps

| # | File | What | Risk | Depends |
|---|------|------|------|---------|
| E.1 | `src/orchestrator/core-loop.ts` (MODIFY) | Add `forwardPredictor?: ForwardPredictor` to `OrchestratorDeps` interface (defined at line ~108). Follow existing optional dep pattern (e.g. `skillManager?`). | 🟢 | — |
| E.2 | `src/orchestrator/core-loop.ts` (MODIFY) | PREDICT phase injection: run `forwardPredictor.predictOutcome()` in parallel with SelfModel using `Promise.race([fp.predictOutcome(), timeout(3000)])`. Store `predictionId` in working memory. On timeout/error: fallback to SelfModel-only, emit `prediction:error`. Merge via `mergeForwardAndSelfModel()` (confidence-weighted). | 🟡 | E.1, FP-C |
| E.3 | `src/orchestrator/core-loop.ts` (MODIFY) | LEARN phase injection: implement `mapTraceOutcome()` per architecture §5.3. If `shouldRecord`: construct `PredictionOutcome`, call `forwardPredictor.recordOutcome()`, emit `prediction:calibration`. If not recording: emit `prediction:outcome-skipped`. | 🟡 | E.1, FP-C |
| E.4 | `src/orchestrator/core-loop.ts` (MODIFY) | Pipeline confidence integration: feed ForwardPredictor confidence into `computePipelineConfidence()` as the `prediction` dimension (weight 0.15). When ForwardPredictor unavailable: use SelfModel metaConfidence as fallback for prediction dimension. | 🟢 | E.2 |
| E.5 | `src/orchestrator/factory.ts` (MODIFY) | Conditional ForwardPredictor creation: if `db && traceStore` exist → create PredictionLedger, TierSelector, OutcomePredictor, CausalPredictor, CalibrationEngine, CausalEdgeExtractor, ForwardPredictorImpl. Inject into OrchestratorDeps. | 🟡 | E.1, FP-A through FP-D |
| E.6 | `src/bus/prediction-listeners.ts` (MODIFY) | Register EventBus listeners: `worldgraph:fact-committed` → refresh causal edge cache, `sleepcycle:analysis-complete` → trigger edge weight update + file stats refresh, `task:completed` → trigger calibration if prediction exists. Add observability listeners for `prediction:*` events (audit logging). | 🟢 | E.2, E.3 |
| E.7 | `src/core/event-bus.ts` (MODIFY) | Register event types: `prediction:generated`, `prediction:calibration`, `prediction:miscalibration`, `prediction:tier-transition`, `prediction:error`, `prediction:outcome-skipped`, `plan:counterfactual`, `calibration:diagnostics_ready`, `calibration:weights_converged`, `datagate:prediction-tier-unlocked`. | 🟢 | — |

### Tests

| File | Key Scenarios |
|------|---------------|
| `tests/orchestrator/core-loop-prediction.test.ts` | PREDICT: ForwardPredictor called in parallel, timeout → SelfModel fallback, error → graceful skip. LEARN: mapTraceOutcome covers all 4 trace outcomes (success→pass, failure→partial/fail, timeout→skip, escalated→shadowValidation or skip). Pipeline confidence includes prediction dimension. |
| `tests/orchestrator/factory-prediction.test.ts` | With DB: ForwardPredictor created + wired. Without DB: ForwardPredictor undefined, core loop unaffected. |
| `tests/bus/prediction-listeners.test.ts` | Event routing: fact-committed → cache refresh. sleepcycle → weight update. task:completed → calibration triggered. |

### Verification Gate

- ✅ Core loop works with `forwardPredictor = undefined` (Phase 1 compatibility)
- ✅ 3s timeout: PREDICT phase never exceeds 3.5s even if ForwardPredictor hangs
- ✅ mapTraceOutcome: all 4 ExecutionTrace outcomes mapped correctly
- ✅ Pipeline confidence: prediction dimension populated when FP available
- ✅ Events emitted: prediction:generated on PREDICT, prediction:calibration on LEARN
- ✅ No regressions in existing core-loop tests
- ✅ `bun run test` passes, `bun run check` clean

---

## FP-F: Calibration V2

### Prerequisites
- FP-E complete (core loop wiring, prediction events flowing)
- ≥ 100 traces accumulated (data gate for Tier 2+)

### Steps

| # | File | What | Risk | Depends |
|---|------|------|------|---------|
| F.1 | `src/orchestrator/calibration-engine.ts` (MODIFY) | Implement full Brier decomposition per §4.2: `getBrierDecomposition()` returns `{ reliability, resolution, uncertainty, brierScore }`. Adaptive binning: 100–500 traces → 5 bins, 500–2000 → 8 bins, 2000+ → 10 bins. Min 20 samples/bin. | 🟡 | FP-E |
| F.2 | `src/orchestrator/calibration-engine.ts` (MODIFY) | CRPS as primary continuous metric per §4.3. `scoreContinuous()` now returns CRPS instead of MAPE. Compute both in parallel during migration window. CalibrationSummary: promote `crpsBlastAvg`, `crpsQualityAvg` to required fields. Mark `blastMAPE`, `qualityMAE` as `@deprecated`. | 🟡 | F.1 |
| F.3 | `src/orchestrator/calibration-engine.ts` (MODIFY) | Implement `getReliabilityDiagram()` per §4.6: returns `{ bins: Array<{ predictedMean, observedFrequency, count }>, calibrationError: number (RMSE), poeProbability: number }`. Alert: calibrationError > 0.15 → emit `calibration:diagnostics_ready` with warning. | 🟢 | F.1 |
| F.4 | `src/orchestrator/calibration-engine.ts` (MODIFY) | Emit `calibration:diagnostics_ready` every 50 predictions with full BrierDecomposition + alerts. Alert thresholds per §4.2: REL > 0.3 → 🔴 critical, RES < 0.05 → 🟡 warning, ΔREL > 0.15 in 50 predictions → 🟡 distribution shift. | 🟢 | F.1, F.3 |
| F.5 | `src/orchestrator/forward-predictor-types.ts` (MODIFY) | Update `ForwardPredictor.getCalibrationSummary()` return type: add `crpsBlastAvg`, `crpsQualityAvg`, `brierReliability`, `brierResolution`, `brierUncertainty`, `edgeWeightsConverged`, `calibrationBins[]`. Keep `blastMAPE`, `qualityMAE` as deprecated optional. | 🟡 | F.2 |

### Tests

| File | Key Scenarios |
|------|---------------|
| `tests/orchestrator/calibration-brier-decomposition.test.ts` | Identity: BS = REL - RES + UNC on known data. Adaptive binning: 100 → 5 bins, 1000 → 8 bins. Perfect predictor: REL ≈ 0, RES > 0. Random predictor: REL ≈ 0, RES ≈ 0. |
| `tests/orchestrator/calibration-crps.test.ts` | CRPS < MAPE for well-calibrated distributions. Honest uncertainty rewarded: wide bounds when uncertain scores better than narrow. Perfect point prediction: CRPS → 0. |
| `tests/orchestrator/calibration-reliability.test.ts` | Reliability diagram: perfect calibration → calibrationError ≈ 0. Overconfident predictor → calibrationError > 0.15 → alert emitted. PoE target: ~20% for 10th/90th percentile bounds. |
| `tests/orchestrator/calibration-alerts.test.ts` | Alert thresholds: REL > 0.3 triggers critical. RES < 0.05 triggers warning. ΔREL spike triggers distribution shift warning. Diagnostics emitted every 50 predictions. |

### Verification Gate

- ✅ Brier decomposition identity holds on all test fixtures
- ✅ CRPS rewards honest uncertainty (narrower correct < narrower wrong < wider)
- ✅ Reliability diagram produces calibration error metric
- ✅ Alerts fire at correct thresholds
- ✅ CalibrationSummary includes both CRPS and deprecated MAPE
- ✅ `bun run test` passes, `bun run check` clean

---

## FP-G: Counterfactual Planning

### Prerequisites
- FP-F complete (calibration v2 with full Brier/CRPS)
- Tier 3 active (≥ 100 traces + ≥ 50 causal edges)

### Steps

| # | File | What | Risk | Depends |
|---|------|------|------|---------|
| G.1 | `src/orchestrator/task-decomposer.ts` (MODIFY) | Add `generatePlans(input, perception, memory, N)` → `Plan[]`. Generates N alternative plans by varying decomposition strategy (greedy: fewest subtasks, conservative: largest blast radius first, balanced: mixed). Uses LLM with different prompts per strategy. N defaults to 3, configurable via `ForwardPredictorConfig.budgets.maxAlternativePlans`. | 🔴 | FP-F |
| G.2 | `src/orchestrator/forward-predictor.ts` (MODIFY) | Add `scorePlan(plan)` → `PlanScore`. For each subtask in plan: call `predictOutcome()` with subtask scope. Aggregate: `expectedQuality = min(subtask qualities)` (worst-case), `expectedDuration = sum(durations)`, `riskAdjustedQuality = quality × (1 - 0.3 × normalizedBlast) × √confidence`. Implement `normalizeBlastRadius()` per architecture §10.2 (percentile-rank normalization, [p10,p90] → [0.1,0.9] linear, >p90 log-compressed). | 🟡 | FP-F |
| G.3 | `src/orchestrator/core-loop.ts` (MODIFY) | PLAN phase: if counterfactual gate active (Tier 3 + task type ≥ 20 traces + plan ≥ 3 subtasks + budget allows 3.5s) → `decomposer.generatePlans(N=3)`, score each with `forwardPredictor.scorePlan()`, select highest `riskAdjustedQuality`. Emit `plan:counterfactual` event with all scores. Otherwise: use single plan as before. | 🟡 | G.1, G.2 |
| G.4 | `src/db/prediction-ledger.ts` (MODIFY) | Add `recordPlanRanking(record: PlanRankingRecord)`. Store all plan predictions (selected + non-selected) for post-hoc analysis per architecture §10.4. Record: taskId, selectedPlanId, selectedReason, plan rankings with predicted outcomes, actual outcome (only for executed plan). | 🟢 | G.3 |
| G.5 | `src/orchestrator/forward-predictor.ts` (MODIFY) | Counterfactual activation gate: check Tier 3 active, task type ≥ 20 prior traces, plan complexity ≥ 3 subtasks, budget allows 2s for plan generation + 1.5s for scoring. If any condition fails → single plan path. | 🟢 | G.2 |

### Tests

| File | Key Scenarios |
|------|---------------|
| `tests/orchestrator/task-decomposer-plans.test.ts` | generatePlans(3) produces 3 distinct plans. Each plan is valid (no cycles, all files covered). Different strategies produce different subtask orderings. |
| `tests/orchestrator/forward-predictor-scoring.test.ts` | scorePlan: worst-case quality propagates. normalizeBlastRadius: p10 → 0.1, p50 → 0.5, p90 → 0.9, 2×p90 → ~0.95 (log compression). riskAdjustedQuality monotonically increases with quality, decreases with blast. |
| `tests/orchestrator/core-loop-counterfactual.test.ts` | Gate active: 3 plans generated, best selected, all recorded. Gate inactive (< 20 traces): single plan used. Budget exceeded: fallback to single plan. plan:counterfactual event emitted with scores. |
| `tests/db/prediction-ledger-ranking.test.ts` | PlanRankingRecord persistence: all plans stored, only selected has actualOutcome. Query: retrieve ranking history for task type analysis. |

### Verification Gate

- ✅ generatePlans produces N distinct valid plans
- ✅ scorePlan ranks plans correctly (highest quality, lowest risk wins)
- ✅ normalizeBlastRadius matches architecture §10.2 specification
- ✅ Activation gate prevents counterfactual when insufficient data
- ✅ All plan predictions persisted (selected + non-selected)
- ✅ Total PLAN phase ≤ 5s with counterfactual (2s generation + 1.5s scoring + overhead)
- ✅ No regressions in existing core-loop tests
- ✅ `bun run test` passes, `bun run check` clean

---

## 3. Cross-Cutting Concerns

### Observability

All ForwardPredictor events follow EventBus pattern. Key events for monitoring:

| Event | When | Severity Signal |
|-------|------|-----------------|
| `prediction:generated` | Every PREDICT | Normal — tier, confidence |
| `prediction:calibration` | Every LEARN with recorded outcome | Normal — brierScore |
| `prediction:miscalibration` | Brier > 0.4 over window | 🔴 — tier degradation triggered |
| `prediction:tier-transition` | Tier change (up or down) | 🟡 — data gate crossed or degradation |
| `prediction:error` | ForwardPredictor threw/timed out | 🟡 — graceful degradation active |
| `calibration:diagnostics_ready` | Every 50 predictions | Info — BrierDecomposition + alerts |
| `calibration:weights_converged` | 200+ traces per edge type | Info — edge weights fully learned |

### Error Boundaries

Every ForwardPredictor call in core-loop is wrapped in try/catch with fallback:
- PREDICT: timeout(3000) → SelfModel-only
- LEARN: recordOutcome failure → emit event, continue
- PLAN (counterfactual): scorePlan failure → use first plan

### Performance

Total prediction budget: **< 150ms** (architecture §3.5). Each tier additive:
- T1: ~2ms (SelfModel wrap)
- T2: ~20ms (percentile queries)
- T3: ~60ms (BFS + aggregation)
- Counterfactual: +3.5s budget (2s generation + 1.5s scoring)

### Backward Compatibility

- `ForwardPredictor` is optional in `OrchestratorDeps` — system works without it
- CalibrationSummary migration is staged: optional → required → remove deprecated
- No existing test regressions at any phase boundary

---

## 4. Implementation Order Summary

```
Week 1:  FP-A (Foundation) — schema, ledger, tier selector, config
         FP-B (Causal Edges) — extractor, WorldGraph extensions  [parallel with FP-A]
         
Week 2:  FP-C (Core Predictor) — OutcomePredictor, CausalPredictor, ForwardPredictorImpl, CalibrationEngine
         
Week 3:  FP-D (Causal Advanced) — edge weight learning, trace mining, miscalibration
         FP-E (Core Loop Wiring) — deps, factory, PREDICT/LEARN injection, events

Week 4:  FP-F (Calibration V2) — Brier decomposition, CRPS, reliability diagrams, alerts
         
Week 5+: FP-G (Counterfactual) — plan generation, scoring, ranking, persistence
```

**Critical path**: FP-A → FP-C → FP-E → FP-F → FP-G
**Parallel path**: FP-B can run alongside FP-A; FP-D can start alongside FP-E

---

## 5. Risk Matrix

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| AST parsing failures in CausalEdgeExtractor | Medium | Low | Return empty edges → Tier 2 only; no block |
| Percentile queries slow on large trace sets | Low | Medium | Index on (taskType, timestamp); partition by age |
| Brier decomposition numerically unstable with few bins | Medium | Low | Min 20 samples/bin; fallback to aggregate Brier |
| LLM inconsistency in generatePlans() (FP-G) | High | Medium | Validate each plan with DAG criteria; fallback to single plan |
| Causal BFS explores too many files | Low | Low | Depth-3 limit caps at ~50 files; monitor via events |
| Cold-start S1-S4 conflict with ForwardPredictor tiers | Low | Medium | S1-S4 override tier confidence ceilings; explicit precedence rule |

---

## 6. Open Questions (from Architecture)

Tracked in architecture doc §16. Implementation-relevant decisions:

| # | Question | Decision for Implementation |
|---|---------|---------------------------|
| Q1 | 100 traces sufficient for Tier 2? | Start at 100; monitor Brier. Add config knob to raise to 200 if needed. |
| Q2 | Edge weights vary per oracle? | Start uniform per-edge-type. Oracle dimension deferred to FP-G+. |
| Q3 | Trace-mined false causal edges? | Wilson LB ≥ 0.6 is conservative. Add AST validation in FP-D. |
| Q5 | ForwardPredictor consume LLM? | No — rule-based only (A3). LLM only in FP-G generatePlans(). |
| Q6 | Optimal counterfactual plan count? | Start N=3 (config). Tune in FP-G based on marginal improvement. |
| Q7 | Multi-task interaction prediction (§12 G6)? | Deferred. Requires fleet-level trace data not yet available. Track as FP-G+ extension. |
| Q8 | Sleep Cycle pattern→prediction feedback (§11.3)? | Deferred to FP-D+. Pattern-based feature modifiers need sufficient pattern library (≥50 patterns). |
