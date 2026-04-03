/**
 * ForwardPredictor — Main orchestrator for 3-tier prediction pipeline.
 *
 * Coordinates heuristic → statistical → causal prediction tiers,
 * records outcomes, and maintains calibration state.
 *
 * Axiom: A7 (prediction error as learning signal)
 * Axiom: A3 (deterministic governance — tier selection is rule-based)
 */
import type { ForwardPredictorConfig } from '../config/schema.ts';
import { PredictionLedger } from '../db/prediction-ledger.ts';
import { PredictionTierSelectorImpl } from '../gate/prediction-tier-selector.ts';
import type { WorldGraph } from '../world-graph/world-graph.ts';
import { CalibrationEngineImpl } from './calibration-engine.ts';
import { CausalPredictorImpl } from './causal-predictor.ts';
import type {
  CausalRiskAnalysis,
  ForwardPredictor,
  OutcomePrediction,
  PredictionOutcome,
  StatisticalEnhancement,
} from './forward-predictor-types.ts';
import { OutcomePredictorImpl } from './outcome-predictor.ts';
import type { PerceptualHierarchy, SelfModelPrediction, TaskInput } from './types.ts';

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface ForwardPredictorDeps {
  selfModel: {
    predict(input: TaskInput, perception: PerceptualHierarchy): Promise<SelfModelPrediction>;
  };
  ledger: PredictionLedger;
  worldGraph?: WorldGraph;
  config: ForwardPredictorConfig;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PREDICTION_CACHE_LIMIT = 1000;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class ForwardPredictorImpl implements ForwardPredictor {
  private readonly selfModel: ForwardPredictorDeps['selfModel'];
  private readonly ledger: PredictionLedger;
  private readonly worldGraph: WorldGraph | undefined;
  private readonly config: ForwardPredictorConfig;

  private readonly tierSelector: PredictionTierSelectorImpl;
  private readonly outcomePredictor: OutcomePredictorImpl;
  private readonly causalPredictor: CausalPredictorImpl;
  private readonly calibrationEngine: CalibrationEngineImpl;

  /** Cached predictions for recordOutcome lookups. Oldest-first insertion order. */
  private readonly predictionCache = new Map<string, OutcomePrediction>();

  constructor(deps: ForwardPredictorDeps) {
    this.selfModel = deps.selfModel;
    this.ledger = deps.ledger;
    this.worldGraph = deps.worldGraph;
    this.config = deps.config;

    this.tierSelector = new PredictionTierSelectorImpl({
      minTracesStatistical: deps.config.tiers.statistical.min_traces,
      minTracesCausal: deps.config.tiers.causal.min_traces,
      minEdgesCausal: deps.config.tiers.causal.min_edges,
    });

    this.outcomePredictor = new OutcomePredictorImpl();
    this.causalPredictor = new CausalPredictorImpl();
    this.calibrationEngine = new CalibrationEngineImpl({
      halfLifeDays: deps.config.calibration.temporal_decay_half_life_days,
      miscalibrationThreshold: deps.config.calibration.miscalibration_threshold,
    });
  }

  // -----------------------------------------------------------------------
  // predictOutcome — 3-tier pipeline
  // -----------------------------------------------------------------------

  async predictOutcome(input: TaskInput, perception: PerceptualHierarchy): Promise<OutcomePrediction> {
    // ① SELECT TIER
    const traceCount = this.ledger.getTraceCount();
    const edgeCount = this.worldGraph?.getCausalEdgeCount() ?? 0;
    const recentBrier = this.ledger.getRecentBrierScores(
      this.config.calibration.miscalibration_window,
    );
    const avgBrier = recentBrier.length > 0
      ? recentBrier.reduce((a, b) => a + b, 0) / recentBrier.length
      : 0;
    const miscalibrated = avgBrier > this.config.calibration.miscalibration_threshold;
    const tier = this.tierSelector.select(traceCount, edgeCount, miscalibrated);

    // ② TIER 1: HEURISTIC (always)
    const heuristic = await this.selfModel.predict(input, perception);
    let prediction = this.wrapAsOutcomePrediction(heuristic, input.id, 0.3);

    // ③ TIER 2: STATISTICAL (if eligible)
    if (tier === 'statistical' || tier === 'causal') {
      try {
        const targetFiles = input.targetFiles ?? [];
        const fileStats = this.ledger.getFileOutcomeStats(targetFiles);
        const taskType = input.goal.split(' ')[0] ?? 'unknown';
        const blastPctiles = this.ledger.getPercentiles(taskType, [10, 50, 90]);
        const qualityPctiles = this.ledger.getPercentiles(taskType, [10, 50, 90]);
        const stats = this.outcomePredictor.enhance(heuristic, fileStats, blastPctiles, qualityPctiles);
        prediction = this.blendTier2(prediction, stats);
      } catch {
        // Graceful degradation: keep tier 1 prediction
      }
    }

    // ④ TIER 3: CAUSAL (if eligible)
    if (tier === 'causal') {
      try {
        const edges = perception.causalEdges ?? [];
        const targetFiles = input.targetFiles ?? [];
        const fileStats = this.ledger.getFileOutcomeStats(targetFiles);
        const causal = this.causalPredictor.computeRisks(
          targetFiles,
          edges,
          fileStats,
          prediction.testOutcome.pPass,
          this.calibrationEngine.getEdgeWeights(),
        );
        prediction = this.applyCausalRisks(prediction, causal);
      } catch {
        // Graceful degradation: keep tier 2 prediction
      }
    }

    // ⑤ PERSIST
    this.ledger.recordPrediction(prediction);
    this.cachePrediction(prediction);

    return prediction;
  }

  // -----------------------------------------------------------------------
  // recordOutcome — score and persist
  // -----------------------------------------------------------------------

  async recordOutcome(outcome: PredictionOutcome): Promise<number> {
    const pred = this.predictionCache.get(outcome.predictionId);
    if (!pred) {
      // No cached prediction — record with zero scores
      this.ledger.recordOutcome(outcome, 0, 0, 0);
      return 0;
    }

    const brierScore = this.calibrationEngine.scoreTestOutcome(
      pred.testOutcome,
      outcome.actualTestResult,
    );
    const crpsBlast = this.calibrationEngine.scoreContinuous(
      pred.blastRadius,
      outcome.actualBlastRadius,
    );
    const crpsQuality = this.calibrationEngine.scoreContinuous(
      pred.qualityScore,
      outcome.actualQuality,
    );

    this.ledger.recordOutcome(outcome, brierScore, crpsBlast, crpsQuality);
    this.predictionCache.delete(outcome.predictionId);

    return brierScore;
  }

  // -----------------------------------------------------------------------
  // getCalibrationSummary — legacy interface adapter
  // -----------------------------------------------------------------------

  getCalibrationSummary(): {
    brierScore: number;
    blastMAPE: number;
    qualityMAE: number;
    predictionCount: number;
    basis: 'heuristic' | 'statistical' | 'causal';
  } {
    const summary = this.calibrationEngine.getCalibrationSummary();
    return {
      brierScore: summary.brierScore,
      blastMAPE: summary.crpsBlastAvg,
      qualityMAE: summary.crpsQualityAvg,
      predictionCount: summary.predictionCount,
      basis: summary.basis,
    };
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private wrapAsOutcomePrediction(
    heuristic: SelfModelPrediction,
    taskId: string,
    confidence: number,
  ): OutcomePrediction {
    const pPass = heuristic.expectedTestResults === 'pass' ? 0.7 : heuristic.expectedTestResults === 'partial' ? 0.3 : 0.1;
    const pFail = heuristic.expectedTestResults === 'fail' ? 0.7 : 0.1;
    const pPartial = 1.0 - pPass - pFail;

    return {
      predictionId: crypto.randomUUID(),
      taskId,
      timestamp: Date.now(),
      testOutcome: { pPass, pPartial, pFail },
      blastRadius: {
        lo: heuristic.expectedBlastRadius * 0.5,
        mid: heuristic.expectedBlastRadius,
        hi: heuristic.expectedBlastRadius * 2.0,
      },
      qualityScore: {
        lo: Math.max(0, heuristic.expectedQualityScore - 0.15),
        mid: heuristic.expectedQualityScore,
        hi: Math.min(1.0, heuristic.expectedQualityScore + 0.1),
      },
      expectedDuration: heuristic.expectedDuration,
      causalRiskFiles: [],
      basis: 'heuristic',
      causalChainDepth: 0,
      confidence,
    };
  }

  private blendTier2(tier1: OutcomePrediction, stats: StatisticalEnhancement): OutcomePrediction {
    return {
      ...tier1,
      testOutcome: stats.testOutcome,
      blastRadius: stats.blastRadius,
      qualityScore: stats.qualityScore,
      basis: 'statistical',
      confidence: stats.confidence,
    };
  }

  private applyCausalRisks(tier2: OutcomePrediction, causal: CausalRiskAnalysis): OutcomePrediction {
    const pPass = causal.adjustedPPass;
    const pPartial = tier2.testOutcome.pPartial;
    const pFail = Math.max(0, 1.0 - pPass - pPartial);
    const total = pPass + pPartial + pFail;

    return {
      ...tier2,
      testOutcome: {
        pPass: total > 0 ? pPass / total : 0,
        pPartial: total > 0 ? pPartial / total : 0,
        pFail: total > 0 ? pFail / total : 0,
      },
      causalRiskFiles: causal.riskFiles,
      basis: 'causal',
      confidence: clamp(tier2.confidence + 0.1, 0.6, 0.95),
      causalChainDepth: 3,
    };
  }

  private cachePrediction(prediction: OutcomePrediction): void {
    if (this.predictionCache.size >= PREDICTION_CACHE_LIMIT) {
      // Evict oldest entry (first key in insertion-order Map)
      const oldestKey = this.predictionCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.predictionCache.delete(oldestKey);
      }
    }
    this.predictionCache.set(prediction.predictionId, prediction);
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
