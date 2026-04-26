# Vinyan World Model / Forward Predictor — Design Document

> 🔧 **Status: Mixed.** Heuristic and statistical tiers are **live as `ForwardPredictor`** (see `src/orchestrator/prediction/`). Causal tier (counterfactual generation) is **still pending** — it requires ML training data and is not yet wired. GAP-A (forward-looking world model vs the backward-looking World Graph) remains partially open; see `analysis/gap-analysis.md` §7.

**Status:** Heuristic + Statistical tiers shipped; Causal tier pending data
**GAP Reference:** ../analysis/gap-analysis.md Section 10.2, GAP-A
**Phase:** Phase 2+ (builds on Phase 1 CalibratedSelfModel, Phase 0 WorldGraph)
**Date:** 2026-04-01

---

## 1. Problem Statement

The gap analysis (Section 10.2) identifies that Vinyan is **backward-looking and reactive**:

- **Self-Model** predicts via exponential moving averages of historical outcomes but cannot reason about causal chains between files, types, and tests.
- **World Graph** stores "what IS true now" (verified facts) but cannot answer "what WILL happen if I change file X."
- **Dependency edges** are flat (`imports` only) — the system has no awareness of semantic relationships like method calls, class inheritance, type usage, or test coverage mapping.
- **QualityScore** is computed **post-hoc** after oracle verification, not **predicted pre-dispatch** for plan ranking.

The AGI consensus requirement (Bareš, 2025) states: *"world-model is non-optional — systems must predict consequences before executing."*

### What This Design Delivers

A **Forward Predictor** that answers, before worker dispatch:
1. What is P(tests pass) given this task on these files?
2. What is the expected blast radius distribution (not just a point estimate)?
3. What is the predicted QualityScore range for this task-type + file-context?
4. Which files are most likely to break, and through which causal pathways?

---

## 2. Architecture Overview

### 2.1 Component Placement in Core Loop

```
PERCEIVE  ──>  PREDICT (ForwardPredictor)  ──>  PLAN  ──>  GENERATE  ──>  VERIFY  ──>  LEARN
   |                  |                           |                           |            |
   v                  v                           v                           v            v
PerceptionAssembler  SelfModel.predict()    TaskDecomposer            OracleGate    TraceCollector
+ WorldGraph.query   + ForwardPredictor     uses predictions          actual         + ForwardPredictor
  CausalEdges          .predictOutcome()    to rank sub-plans         outcome          .recordOutcome()
```

### 2.2 Module Decomposition

| Module | File | Responsibility |
|--------|------|---------------|
| `ForwardPredictor` | `src/orchestrator/forward-predictor.ts` | Orchestrates causal prediction: combines causal graph traversal with historical trace statistics |
| `CausalEdgeExtractor` | `src/oracle/dep/causal-edge-extractor.ts` | Extends dep-analyzer with semantic edge extraction |
| `OutcomePredictor` | `src/orchestrator/outcome-predictor.ts` | Pure statistical module: produces `OutcomePrediction` |
| `PredictionLedger` | `src/db/prediction-ledger.ts` | SQLite persistence for prediction-vs-actual pairs |
| WorldGraph (extended) | `src/world-graph/world-graph.ts` | New causal edge types, edge-type-aware BFS traversal |
| DataGate (extended) | `src/orchestrator/data-gate.ts` | New feature gate: `forward_predictor` requiring >= 100 traces |

---

## 3. Schema Changes

All schema changes are **additive** — no existing columns or tables are modified.

### 3.1 Migration 004: Causal Edges and Prediction Ledger

```sql
-- Symbol-level causal edges (finer granularity than file-level)
CREATE TABLE IF NOT EXISTS causal_edges (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  from_file   TEXT NOT NULL,
  from_symbol TEXT,
  to_file     TEXT NOT NULL,
  to_symbol   TEXT,
  edge_type   TEXT NOT NULL
              CHECK(edge_type IN (
                'calls-method', 'extends-class', 'implements-interface',
                'uses-type', 'test-covers', 're-exports'
              )),
  confidence  REAL NOT NULL DEFAULT 1.0,
  source      TEXT NOT NULL DEFAULT 'static',
  updated_at  INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_ce_from ON causal_edges(from_file);
CREATE INDEX IF NOT EXISTS idx_ce_to ON causal_edges(to_file);
CREATE INDEX IF NOT EXISTS idx_ce_type ON causal_edges(edge_type);

-- Prediction Ledger: every forward prediction recorded for calibration
CREATE TABLE IF NOT EXISTS prediction_ledger (
  id                    TEXT PRIMARY KEY,
  task_id               TEXT NOT NULL,
  timestamp             INTEGER NOT NULL,
  p_test_pass           REAL NOT NULL,
  p_test_partial        REAL NOT NULL,
  p_test_fail           REAL NOT NULL,
  predicted_blast_lo    INTEGER NOT NULL,
  predicted_blast_mid   INTEGER NOT NULL,
  predicted_blast_hi    INTEGER NOT NULL,
  predicted_quality_lo  REAL NOT NULL,
  predicted_quality_mid REAL NOT NULL,
  predicted_quality_hi  REAL NOT NULL,
  predicted_duration_ms INTEGER NOT NULL,
  causal_risk_files     TEXT,
  prediction_basis      TEXT NOT NULL,
  causal_chain_depth    INTEGER DEFAULT 0,
  actual_test_result    TEXT,
  actual_blast_radius   INTEGER,
  actual_quality        REAL,
  actual_duration_ms    INTEGER,
  brier_score           REAL,
  blast_error           REAL,
  quality_error         REAL,
  calibrated_at         INTEGER
);

CREATE INDEX IF NOT EXISTS idx_pl_task ON prediction_ledger(task_id);

-- Per-file outcome history (aggregated, refreshed by Sleep Cycle)
CREATE TABLE IF NOT EXISTS file_outcome_stats (
  file_path         TEXT NOT NULL,
  edge_type_context TEXT NOT NULL DEFAULT 'any',
  total_tasks       INTEGER NOT NULL DEFAULT 0,
  success_count     INTEGER NOT NULL DEFAULT 0,
  fail_count        INTEGER NOT NULL DEFAULT 0,
  avg_quality       REAL NOT NULL DEFAULT 0.5,
  last_updated      INTEGER NOT NULL,
  PRIMARY KEY (file_path, edge_type_context)
);
```

---

## 4. TypeScript Interfaces

### 4.1 Core Types (`src/orchestrator/forward-predictor-types.ts`)

```typescript
export type CausalEdgeType =
  | 'calls-method' | 'extends-class' | 'implements-interface'
  | 'uses-type' | 'test-covers' | 're-exports';

export interface CausalEdge {
  fromFile: string;
  fromSymbol?: string;
  toFile: string;
  toSymbol?: string;
  edgeType: CausalEdgeType;
  confidence: number;       // 1.0 for static, <1.0 for inferred
  source: 'static' | 'inferred' | 'trace-mined';
}

export interface TestOutcomeDistribution {
  pPass: number;
  pPartial: number;
  pFail: number;
}

export interface PredictionDistribution {
  lo: number;    // 10th percentile
  mid: number;   // 50th percentile (median)
  hi: number;    // 90th percentile
}

export interface OutcomePrediction {
  predictionId: string;
  taskId: string;
  timestamp: number;
  testOutcome: TestOutcomeDistribution;
  blastRadius: PredictionDistribution;
  qualityScore: PredictionDistribution;
  expectedDuration: number;
  causalRiskFiles: CausalRiskEntry[];
  basis: 'heuristic' | 'statistical' | 'causal';
  causalChainDepth: number;
  confidence: number;
}

export interface CausalRiskEntry {
  filePath: string;
  breakProbability: number;
  causalChain: Array<{
    fromFile: string;
    toFile: string;
    edgeType: CausalEdgeType | 'imports';
  }>;
  historicalSuccessRate?: number;
}

export interface PredictionOutcome {
  predictionId: string;
  actualTestResult: 'pass' | 'partial' | 'fail';
  actualBlastRadius: number;
  actualQuality: number;
  actualDuration: number;
}
```

### 4.2 ForwardPredictor Interface

```typescript
export interface ForwardPredictor {
  predictOutcome(input: TaskInput, perception: PerceptualHierarchy): Promise<OutcomePrediction>;
  recordOutcome(outcome: PredictionOutcome): Promise<number>; // returns Brier score
  getCalibrationSummary(): {
    brierScore: number;
    blastMAPE: number;
    qualityMAE: number;
    predictionCount: number;
    basis: 'heuristic' | 'statistical' | 'causal';
  };
}
```

---

## 5. Prediction Pipeline (3 Tiers)

### Tier 1: Heuristic (< 100 traces) — Always Active

Wraps existing `CalibratedSelfModel.predict()` in `OutcomePrediction` format with wide uncertainty bounds. Confidence capped at 0.3.

### Tier 2: Statistical (>= 100 traces)

Uses historical trace distribution for task-type + affected files:
- Empirical percentiles for blast radius and quality score
- Bayesian update of pass probability blending task-type prior with file-level likelihood
- `file_outcome_stats` table for fast per-file success rate lookup

### Tier 3: Causal (>= 100 traces AND causal edges present)

Extends Tier 2 with causal graph traversal:
1. BFS over `causal_edges` from target files (max depth 3)
2. Per-file break probability = path weight product * historical fail rate
3. Adjusted overall P(pass) accounting for causal risk
4. Top 10 risk files with causal chain explanation

### Edge Weight Table

| Edge Type | Weight | Rationale |
|-----------|--------|-----------|
| `test-covers` | 0.95 | Test covering file is almost certainly affected |
| `extends-class` | 0.85 | Subclass depends on parent behavior |
| `implements-interface` | 0.80 | Interface changes propagate to implementors |
| `calls-method` | 0.60 | Behavioral coupling, callee may not change |
| `uses-type` | 0.40 | Type changes may be compatible |
| `re-exports` | 0.30 | Only if exported symbol changes |
| `imports` (existing) | 0.20 | Coarse-grained |

---

## 6. Calibration (A7 Loop)

### Metrics

1. **Brier Score** (test outcome): `(pPass - actual)² + (pPartial - actual)² + (pFail - actual)²` — range [0,2], lower = better
2. **Blast MAPE**: `|actual - predicted_mid| / max(1, predicted_mid)`
3. **Quality MAE**: `|actual - predicted_mid|`

### Feedback Loop

After VERIFY step: `forwardPredictor.recordOutcome()` → compute metrics → update ledger → rolling EMA calibration. If Brier > 0.4 over 20 predictions → emit `forwardpredictor:miscalibration` event.

### Trace-Mined Edges

During Sleep Cycle: if files A and B co-occur in failed traces (Wilson LB >= 0.6, >= 10 observations), insert inferred causal edge with lower confidence.

---

## 7. Data Gates

| Feature | Threshold |
|---------|-----------|
| Tier 1 (heuristic) | Always active |
| Tier 2 (statistical) | trace_count >= 100, distinct_task_types >= 5 |
| Tier 3 (causal) | trace_count >= 100, causal_edge_count >= 50 |
| Causal risk in routing | trace_count >= 200, prediction_accuracy >= 0.6 |
| QualityScore pre-dispatch | trace_count >= 100, quality MAE < 0.15 |

---

## 8. Integration Points

### Core Loop

- **PREDICT step**: `forwardPredictor.predictOutcome()` after SelfModel prediction
- **PLAN step**: use predicted QualityScore for plan ranking
- **LEARN step**: `forwardPredictor.recordOutcome()` for calibration
- **Escalation**: if max causal risk > 0.7, escalate routing level

### OrchestratorDeps

Add `forwardPredictor?: ForwardPredictor` to OrchestratorDeps interface.

### WorldGraph Extensions

New methods: `storeCausalEdges()`, `queryCausalDependents()`, `countCausalEdges()`, `clearCausalEdgesForFile()`.

### Bus Events

- `forwardpredictor:predict` — prediction produced
- `forwardpredictor:outcome` — prediction calibrated
- `forwardpredictor:miscalibration` — accuracy degraded

---

## 9. Implementation Sequence

| Phase | Items |
|-------|-------|
| **A: Foundation** | Migration 004, forward-predictor-types.ts, PredictionLedger, DataGate extensions |
| **B: Causal Edges** | CausalEdgeExtractor, WorldGraph extensions, PerceptionAssembler integration |
| **C: Forward Predictor** | OutcomePredictor (Tier 1/2/3), ForwardPredictorImpl, calibration |
| **D: Core Loop** | Wire into PREDICT + LEARN steps, factory, bus events, ExecutionTrace extension |
| **E: Sleep Cycle** | Trace-mined edge inference, file_outcome_stats refresh, counterfactual enhancement |

---

## 10. Relationship to Existing Components

| Aspect | CalibratedSelfModel (existing) | ForwardPredictor (new) |
|--------|-------------------------------|----------------------|
| Scope | Per-task-type EMA | Per-task + per-file + causal graph |
| Output | Point estimates | Distributional (percentiles) |
| Causal reasoning | None | BFS over typed causal edges |
| Calibration | Composite error | Brier score (proper scoring rule) |
| Data gate | Active from first task | Tier 2 at 100 traces |
| Cold-start | S1-S4 safeguards | Degrades to Tier 1 (wraps SelfModel) |

The two coexist: SelfModel handles cold-start; ForwardPredictor adds distributional uncertainty and causal reasoning as data accumulates.
