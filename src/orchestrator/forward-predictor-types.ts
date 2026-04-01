/**
 * Forward Predictor Types — World Model interfaces for Vinyan ENS.
 *
 * GAP-A resolution: transforms the system from backward-looking (verified facts)
 * to forward-looking (predicted outcomes before dispatch).
 *
 * Axiom: A7 (prediction error as learning signal)
 * Source: docs/design/world-model.md
 */
import type { TaskInput, PerceptualHierarchy } from "./types.ts";

// ---------------------------------------------------------------------------
// Causal Edge Types
// ---------------------------------------------------------------------------

/** Semantic causal edge types beyond 'imports'. */
export type CausalEdgeType =
  | "calls-method"
  | "extends-class"
  | "implements-interface"
  | "uses-type"
  | "test-covers"
  | "re-exports";

/** A causal edge between two symbols (or files when symbol is undefined). */
export interface CausalEdge {
  fromFile: string;
  fromSymbol?: string;
  toFile: string;
  toSymbol?: string;
  edgeType: CausalEdgeType;
  /** 1.0 for static analysis, <1.0 for trace-inferred edges */
  confidence: number;
  /** How the edge was discovered */
  source: "static" | "inferred" | "trace-mined";
}

// ---------------------------------------------------------------------------
// Prediction Distributions
// ---------------------------------------------------------------------------

/** Probability distribution over discrete test outcomes. Must sum to 1.0. */
export interface TestOutcomeDistribution {
  pPass: number;
  pPartial: number;
  pFail: number;
}

/** Prediction with uncertainty bounds (10th/50th/90th percentiles). */
export interface PredictionDistribution {
  lo: number;   // 10th percentile (optimistic)
  mid: number;  // 50th percentile (median estimate)
  hi: number;   // 90th percentile (pessimistic)
}

// ---------------------------------------------------------------------------
// Outcome Prediction
// ---------------------------------------------------------------------------

/**
 * Complete outcome prediction produced by the Forward Predictor.
 * Answers "what will happen if we dispatch this task to a worker?"
 */
export interface OutcomePrediction {
  predictionId: string;
  taskId: string;
  timestamp: number;

  testOutcome: TestOutcomeDistribution;
  blastRadius: PredictionDistribution;
  qualityScore: PredictionDistribution;
  expectedDuration: number;

  /** Files ranked by causal risk — most likely to break on target file change. */
  causalRiskFiles: CausalRiskEntry[];

  /** Which prediction method was used. */
  basis: "heuristic" | "statistical" | "causal";

  /** Maximum causal chain depth used. */
  causalChainDepth: number;

  /** Overall confidence in this prediction (0.0-1.0). */
  confidence: number;
}

/** A file at risk due to causal dependency on the task's target files. */
export interface CausalRiskEntry {
  filePath: string;
  breakProbability: number;
  causalChain: Array<{
    fromFile: string;
    toFile: string;
    edgeType: CausalEdgeType | "imports";
    fromSymbol?: string;
    toSymbol?: string;
  }>;
  historicalSuccessRate?: number;
}

/** Recorded outcome for calibration (written after VERIFY step). */
export interface PredictionOutcome {
  predictionId: string;
  actualTestResult: "pass" | "partial" | "fail";
  actualBlastRadius: number;
  actualQuality: number;
  actualDuration: number;
}

// ---------------------------------------------------------------------------
// Edge Weights (coupling strength for causal prediction)
// ---------------------------------------------------------------------------

/** Causal coupling strength per edge type — higher = stronger coupling. */
export const CAUSAL_EDGE_WEIGHTS: Record<CausalEdgeType | "imports", number> = {
  "test-covers": 0.95,
  "extends-class": 0.85,
  "implements-interface": 0.80,
  "calls-method": 0.60,
  "uses-type": 0.40,
  "re-exports": 0.30,
  "imports": 0.20,
};

// ---------------------------------------------------------------------------
// Forward Predictor Interface
// ---------------------------------------------------------------------------

/**
 * Forward Predictor — the World Model component of Vinyan.
 *
 * Produces probabilistic predictions of task outcomes BEFORE worker dispatch.
 * Predictions are recorded in the PredictionLedger and compared against
 * actual outcomes in the LEARN step, closing the A7 calibration loop.
 *
 * Data-gated: returns heuristic-only predictions until >= 100 traces exist.
 */
export interface ForwardPredictor {
  predictOutcome(
    input: TaskInput,
    perception: PerceptualHierarchy,
  ): Promise<OutcomePrediction>;

  /** Record actual outcome and compute prediction error. Returns Brier score. */
  recordOutcome(outcome: PredictionOutcome): Promise<number>;

  /** Get calibration summary: how accurate is the predictor? */
  getCalibrationSummary(): {
    brierScore: number;
    blastMAPE: number;
    qualityMAE: number;
    predictionCount: number;
    basis: "heuristic" | "statistical" | "causal";
  };
}
