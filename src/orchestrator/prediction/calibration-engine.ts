/**
 * Calibration & Scoring Engine — Brier decomposition, CRPS, and adaptive edge weights.
 *
 * Pure computation module: no DB, no I/O. All state is in-memory.
 * Axiom: A7 (prediction error as learning signal)
 */
import type {
  BrierDecomposition,
  CalibrationSummary,
  CausalEdgeType,
  LearnedEdgeWeights,
  PredictionDistribution,
  ReliabilityDiagramData,
  TestOutcomeDistribution,
} from './forward-predictor-types.ts';
import { CAUSAL_EDGE_WEIGHTS } from './forward-predictor-types.ts';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface CalibrationEngine {
  scoreTestOutcome(predicted: TestOutcomeDistribution, actual: 'pass' | 'partial' | 'fail'): number;
  scoreContinuous(predicted: PredictionDistribution, actual: number): number;
  scoreInterval(predicted: PredictionDistribution, actual: number, kind?: 'blast' | 'quality'): number;
  getBrierDecomposition(): BrierDecomposition;
  getReliabilityDiagram(): ReliabilityDiagramData;
  getCalibrationSummary(): CalibrationSummary;
  getEdgeWeights(): LearnedEdgeWeights;
  updateEdgeWeights(observations: Array<{ edgeType: CausalEdgeType | 'imports'; brokeTarget: boolean }>): void;
  setTemporalDecayHalfLife(days: number): void;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ScoredPrediction {
  predicted: TestOutcomeDistribution;
  actual: 'pass' | 'partial' | 'fail';
  brierScore: number;
  timestamp: number;
}

interface ContinuousScore {
  kind: 'blast' | 'quality';
  crps: number;
  timestamp: number;
}

interface IntervalScore {
  kind: 'blast' | 'quality';
  score: number;
  insideInterval: boolean;
  timestamp: number;
}

interface EdgeObservation {
  edgeType: CausalEdgeType | 'imports';
  brokeTarget: boolean;
  timestamp: number;
}

interface CalibrationConfig {
  halfLifeDays: number;
  miscalibrationThreshold: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_EDGE_TYPES: ReadonlyArray<CausalEdgeType | 'imports'> = [
  'calls-method',
  'extends-class',
  'implements-interface',
  'uses-type',
  'test-covers',
  're-exports',
  'imports',
];

function indicatorVector(actual: 'pass' | 'partial' | 'fail'): [number, number, number] {
  switch (actual) {
    case 'pass':
      return [1, 0, 0];
    case 'partial':
      return [0, 1, 0];
    case 'fail':
      return [0, 0, 1];
  }
}

function adaptiveBinCount(n: number): number {
  if (n < 100) return 3;
  if (n < 500) return 5;
  if (n < 2000) return 8;
  return 10;
}

/** Logistic ramp for α based on observation count. */
function logisticAlpha(count: number): number {
  if (count < 50) return 0;
  if (count < 100) return 0.3;
  if (count < 200) return 0.5;
  return 1.0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class CalibrationEngineImpl implements CalibrationEngine {
  private readonly config: CalibrationConfig;
  private lambda: number;

  private scoredPredictions: ScoredPrediction[] = [];
  private continuousScores: ContinuousScore[] = [];
  private intervalScores: IntervalScore[] = [];
  private edgeObservations: EdgeObservation[] = [];
  private currentWeights: Record<CausalEdgeType | 'imports', number>;

  constructor(config?: { halfLifeDays?: number; miscalibrationThreshold?: number }) {
    this.config = {
      halfLifeDays: config?.halfLifeDays ?? 30,
      miscalibrationThreshold: config?.miscalibrationThreshold ?? 0.1,
    };
    this.lambda = Math.LN2 / this.config.halfLifeDays;
    this.currentWeights = { ...CAUSAL_EDGE_WEIGHTS };
  }

  // -----------------------------------------------------------------------
  // scoreTestOutcome — 3-class Brier score
  // -----------------------------------------------------------------------

  scoreTestOutcome(predicted: TestOutcomeDistribution, actual: 'pass' | 'partial' | 'fail'): number {
    const [iPass, iPartial, iFail] = indicatorVector(actual);
    const bs =
      (predicted.pPass - iPass) ** 2 +
      (predicted.pPartial - iPartial) ** 2 +
      (predicted.pFail - iFail) ** 2;

    this.scoredPredictions.push({
      predicted,
      actual,
      brierScore: bs,
      timestamp: Date.now(),
    });

    return bs;
  }

  // -----------------------------------------------------------------------
  // scoreInterval — Interval Score (Gneiting & Raftery 2007)
  // IS = (hi - lo) + (2/α)(lo - x)·𝟙(x < lo) + (2/α)(x - hi)·𝟙(x > hi)
  // α = 0.2 for 80% nominal coverage
  // -----------------------------------------------------------------------

  scoreInterval(predicted: PredictionDistribution, actual: number, kind: 'blast' | 'quality' = 'blast'): number {
    const alpha = 0.2;
    const spread = predicted.hi - predicted.lo;
    const undershoot = actual < predicted.lo ? (2 / alpha) * (predicted.lo - actual) : 0;
    const overshoot = actual > predicted.hi ? (2 / alpha) * (actual - predicted.hi) : 0;
    const is = spread + undershoot + overshoot;

    this.intervalScores.push({
      kind,
      score: is,
      insideInterval: actual >= predicted.lo && actual <= predicted.hi,
      timestamp: Date.now(),
    });

    return is;
  }

  // -----------------------------------------------------------------------
  // scoreContinuous — CRPS via percentile approximation
  // -----------------------------------------------------------------------

  scoreContinuous(predicted: PredictionDistribution, actual: number): number {
    const crps = crpsPercentiles(predicted.lo, predicted.mid, predicted.hi, actual);

    // Store two entries: blast and quality are distinguished by caller context.
    // CalibrationEngineImpl doesn't know which — caller tracks via separate calls.
    this.continuousScores.push({
      kind: 'blast',
      crps,
      timestamp: Date.now(),
    });

    return crps;
  }

  // -----------------------------------------------------------------------
  // getBrierDecomposition — Murphy 1973 REL/RES/UNC
  // -----------------------------------------------------------------------

  getBrierDecomposition(): BrierDecomposition {
    const n = this.scoredPredictions.length;
    if (n === 0) {
      return { reliability: 0, resolution: 0, uncertainty: 0, brierScore: 0 };
    }

    const now = Date.now();

    // Base rates per outcome
    let passCount = 0;
    let partialCount = 0;
    let failCount = 0;
    let totalWeight = 0;

    for (const sp of this.scoredPredictions) {
      const w = this.temporalWeight(sp.timestamp, now);
      totalWeight += w;
      if (sp.actual === 'pass') passCount += w;
      else if (sp.actual === 'partial') partialCount += w;
      else failCount += w;
    }

    const basePass = passCount / totalWeight;
    const basePartial = partialCount / totalWeight;
    const baseFail = failCount / totalWeight;

    // 3-class uncertainty: Σ base_k × (1 - base_k)
    const unc =
      basePass * (1 - basePass) +
      basePartial * (1 - basePartial) +
      baseFail * (1 - baseFail);

    // Bin by predicted pPass (primary outcome) for decomposition
    const numBins = adaptiveBinCount(n);
    const sorted = [...this.scoredPredictions].sort((a, b) => a.predicted.pPass - b.predicted.pPass);

    // Equal-count bins
    const binSize = Math.ceil(n / numBins);
    let rel = 0;
    let res = 0;

    for (let b = 0; b < numBins; b++) {
      const start = b * binSize;
      const end = Math.min(start + binSize, n);
      if (start >= n) break;

      const binItems = sorted.slice(start, end);
      let binPredSum = 0;
      let binActualSum = 0;
      let binWeight = 0;

      for (const item of binItems) {
        const w = this.temporalWeight(item.timestamp, now);
        binPredSum += item.predicted.pPass * w;
        binActualSum += (item.actual === 'pass' ? 1 : 0) * w;
        binWeight += w;
      }

      if (binWeight === 0) continue;

      const predictedMean = binPredSum / binWeight;
      const observedFreq = binActualSum / binWeight;
      const nk = binWeight;

      rel += nk * (predictedMean - observedFreq) ** 2;
      res += nk * (observedFreq - basePass) ** 2;
    }

    rel /= totalWeight;
    res /= totalWeight;

    const brierScore = rel - res + unc;

    return { reliability: rel, resolution: res, uncertainty: unc, brierScore };
  }

  // -----------------------------------------------------------------------
  // getReliabilityDiagram
  // -----------------------------------------------------------------------

  getReliabilityDiagram(): ReliabilityDiagramData {
    const n = this.scoredPredictions.length;
    if (n === 0) {
      return { bins: [], calibrationError: 0, poeProbability: 0 };
    }

    const now = Date.now();
    const numBins = adaptiveBinCount(n);
    const sorted = [...this.scoredPredictions].sort((a, b) => a.predicted.pPass - b.predicted.pPass);
    const binSize = Math.ceil(n / numBins);

    const bins: ReliabilityDiagramData['bins'] = [];
    let sumSquaredError = 0;
    let totalWeight = 0;

    for (let b = 0; b < numBins; b++) {
      const start = b * binSize;
      const end = Math.min(start + binSize, n);
      if (start >= n) break;

      const binItems = sorted.slice(start, end);
      let predSum = 0;
      let actualSum = 0;
      let binWeight = 0;

      for (const item of binItems) {
        const w = this.temporalWeight(item.timestamp, now);
        predSum += item.predicted.pPass * w;
        actualSum += (item.actual === 'pass' ? 1 : 0) * w;
        binWeight += w;
      }

      if (binWeight === 0) continue;

      const predictedMean = predSum / binWeight;
      const observedFrequency = actualSum / binWeight;

      bins.push({
        predictedMean,
        observedFrequency,
        count: binItems.length,
      });

      sumSquaredError += binWeight * (predictedMean - observedFrequency) ** 2;
      totalWeight += binWeight;
    }

    const calibrationError = totalWeight > 0 ? Math.sqrt(sumSquaredError / totalWeight) : 0;

    // PoE probability: proportion of bins where |predicted - observed| > threshold
    const overThreshold = bins.filter(
      (b) => Math.abs(b.predictedMean - b.observedFrequency) > this.config.miscalibrationThreshold,
    ).length;
    const poeProbability = bins.length > 0 ? overThreshold / bins.length : 0;

    return { bins, calibrationError, poeProbability };
  }

  // -----------------------------------------------------------------------
  // getCalibrationSummary
  // -----------------------------------------------------------------------

  getCalibrationSummary(): CalibrationSummary {
    const decomp = this.getBrierDecomposition();
    const edgeWeights = this.getEdgeWeights();

    // Average CRPS by kind
    const blastScores = this.continuousScores.filter((s) => s.kind === 'blast');
    const qualityScores = this.continuousScores.filter((s) => s.kind === 'quality');

    const crpsBlastAvg = blastScores.length > 0
      ? blastScores.reduce((s, c) => s + c.crps, 0) / blastScores.length
      : 0;
    const crpsQualityAvg = qualityScores.length > 0
      ? qualityScores.reduce((s, c) => s + c.crps, 0) / qualityScores.length
      : 0;

    // Determine basis from most recent prediction
    const lastPred = this.scoredPredictions[this.scoredPredictions.length - 1];
    const basis: CalibrationSummary['basis'] = lastPred ? 'statistical' : 'heuristic';

    // Build calibration bins from reliability diagram
    const diagram = this.getReliabilityDiagram();
    const numBins = diagram.bins.length;
    const calibrationBins: CalibrationSummary['calibrationBins'] = diagram.bins.map((b, i) => ({
      predictedProbRange: [i / numBins, (i + 1) / numBins] as [number, number],
      actualFrequency: b.observedFrequency,
      count: b.count,
    }));

    // Interval scores by kind
    const blastIntervals = this.intervalScores.filter((s) => s.kind === 'blast');
    const qualityIntervals = this.intervalScores.filter((s) => s.kind === 'quality');

    const intervalScoreBlast = blastIntervals.length > 0
      ? blastIntervals.reduce((s, c) => s + c.score, 0) / blastIntervals.length
      : undefined;
    const intervalScoreQuality = qualityIntervals.length > 0
      ? qualityIntervals.reduce((s, c) => s + c.score, 0) / qualityIntervals.length
      : undefined;
    const coverageBlast = blastIntervals.length > 0
      ? blastIntervals.filter((s) => s.insideInterval).length / blastIntervals.length
      : undefined;
    const coverageQuality = qualityIntervals.length > 0
      ? qualityIntervals.filter((s) => s.insideInterval).length / qualityIntervals.length
      : undefined;

    return {
      brierScore: decomp.brierScore,
      brierReliability: decomp.reliability,
      brierResolution: decomp.resolution,
      brierUncertainty: decomp.uncertainty,
      crpsBlastAvg,
      crpsQualityAvg,
      predictionCount: this.scoredPredictions.length,
      basis,
      edgeWeightsConverged: edgeWeights.converged,
      calibrationBins,
      ...(intervalScoreBlast !== undefined && { intervalScoreBlast }),
      ...(intervalScoreQuality !== undefined && { intervalScoreQuality }),
      ...(coverageBlast !== undefined && { coverageBlast }),
      ...(coverageQuality !== undefined && { coverageQuality }),
    };
  }

  // -----------------------------------------------------------------------
  // Edge Weights
  // -----------------------------------------------------------------------

  getEdgeWeights(): LearnedEdgeWeights {
    return {
      weights: { ...this.currentWeights },
      observationCount: this.edgeObservations.length,
      converged: this.edgeObservations.length >= 200,
    };
  }

  updateEdgeWeights(
    observations: Array<{ edgeType: CausalEdgeType | 'imports'; brokeTarget: boolean }>,
  ): void {
    const now = Date.now();

    for (const obs of observations) {
      this.edgeObservations.push({
        edgeType: obs.edgeType,
        brokeTarget: obs.brokeTarget,
        timestamp: now,
      });
    }

    // Recompute weights per edge type
    for (const edgeType of ALL_EDGE_TYPES) {
      const typeObs = this.edgeObservations.filter((o) => o.edgeType === edgeType);
      if (typeObs.length === 0) continue;

      const alpha = logisticAlpha(typeObs.length);
      if (alpha === 0) continue;

      // Empirical break frequency with temporal decay
      let breakWeightedSum = 0;
      let totalWeight = 0;
      for (const obs of typeObs) {
        const w = this.temporalWeight(obs.timestamp, now);
        breakWeightedSum += (obs.brokeTarget ? 1 : 0) * w;
        totalWeight += w;
      }

      const empiricalFreq = totalWeight > 0 ? breakWeightedSum / totalWeight : 0;
      const defaultWeight = CAUSAL_EDGE_WEIGHTS[edgeType];
      const blended = alpha * empiricalFreq + (1 - alpha) * defaultWeight;
      this.currentWeights[edgeType] = clamp(blended, 0.1, 0.99);
    }
  }

  // -----------------------------------------------------------------------
  // Temporal Decay
  // -----------------------------------------------------------------------

  setTemporalDecayHalfLife(days: number): void {
    this.config.halfLifeDays = days;
    this.lambda = Math.LN2 / days;
  }

  private temporalWeight(timestamp: number, now: number): number {
    const ageDays = (now - timestamp) / (1000 * 60 * 60 * 24);
    return Math.exp(-this.lambda * ageDays);
  }
}

// ---------------------------------------------------------------------------
// CRPS via percentile approximation
// ---------------------------------------------------------------------------

function crpsPercentiles(lo: number, mid: number, hi: number, actual: number): number {
  // mid weighted 2× → 4 samples
  const samples = [lo, mid, mid, hi];
  const n = samples.length;

  // Term 1: E[|Y - actual|]
  let term1 = 0;
  for (const y of samples) {
    term1 += Math.abs(y - actual);
  }
  term1 /= n;

  // Term 2: E[|Yi - Yj|] / 2
  let term2 = 0;
  for (const yi of samples) {
    for (const yj of samples) {
      term2 += Math.abs(yi - yj);
    }
  }
  term2 /= 2 * n * n;

  return term1 - term2;
}
