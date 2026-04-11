/**
 * Tier 2 Statistical OutcomePredictor — Bayesian blend of heuristic priors
 * with file-level empirical evidence.
 *
 * Pure computation module: no I/O, no DB access, no side effects.
 *
 * Axiom: A5 (Tiered Trust) — deterministic > heuristic > probabilistic
 * Axiom: A7 (Prediction Error as Learning) — statistical evidence improves priors
 */
import type { SelfModelPrediction } from '../types.ts';
import type {
  FileOutcomeStat,
  PredictionDistribution,
  StatisticalEnhancement,
  TestOutcomeDistribution,
} from './forward-predictor-types.ts';

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface OutcomePredictor {
  enhance(
    heuristic: SelfModelPrediction,
    fileStats: FileOutcomeStat[],
    blastPercentiles: PredictionDistribution,
    qualityPercentiles: PredictionDistribution,
  ): StatisticalEnhancement;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class OutcomePredictorImpl implements OutcomePredictor {
  enhance(
    heuristic: SelfModelPrediction,
    fileStats: FileOutcomeStat[],
    blastPercentiles: PredictionDistribution,
    qualityPercentiles: PredictionDistribution,
  ): StatisticalEnhancement {
    // Step 1: Task-type prior from SelfModel heuristic
    const prior = this.computePrior(heuristic.expectedTestResults);

    // Step 2 & 3: Bayesian blend with file-level evidence (or pure prior if empty)
    const testOutcome =
      fileStats.length === 0 ? prior : this.bayesianBlend(prior, fileStats);

    // Step 4: Confidence based on evidence quantity
    const confidence = 0.4 + Math.min(0.3, fileStats.length / 100);

    return {
      testOutcome,
      blastRadius: blastPercentiles,
      qualityScore: qualityPercentiles,
      confidence,
    };
  }

  /** Step 1: Derive prior probabilities from the heuristic's discrete prediction. */
  private computePrior(
    expected: 'pass' | 'fail' | 'partial',
  ): TestOutcomeDistribution {
    let pPass: number;
    let pPartial: number;

    if (expected === 'pass') {
      pPass = 0.7;
      pPartial = 0.2;
    } else if (expected === 'partial') {
      pPass = 0.4;
      pPartial = 0.5;
    } else {
      // 'fail'
      pPass = 0.1;
      pPartial = 0.2;
    }

    const pFail = 1 - pPass - pPartial;
    return this.normalize({ pPass, pPartial, pFail });
  }

  /**
   * Steps 2-3: Bayesian blend of prior with file-level evidence.
   * α decays exponentially with evidence count — more files → more weight on data.
   */
  private bayesianBlend(
    prior: TestOutcomeDistribution,
    fileStats: FileOutcomeStat[],
  ): TestOutcomeDistribution {
    // Step 2: File-level likelihood — weighted average success rate
    const withSamples = fileStats.filter((f) => f.samples > 0);
    const fileAvgSuccess =
      withSamples.length === 0
        ? prior.pPass
        : withSamples.reduce((sum, f) => sum + f.successCount / f.samples, 0) /
          withSamples.length;

    // Step 3: Blend weight — α ≈ 0.95 at n=3, ≈ 0.5 at n=35
    const alpha = Math.exp(-fileStats.length / 50);

    const blendedPPass = alpha * prior.pPass + (1 - alpha) * fileAvgSuccess;
    const blendedPPartial =
      alpha * prior.pPartial +
      (1 - alpha) *
        (withSamples.length === 0
          ? prior.pPartial
          : withSamples.reduce(
              (sum, f) => sum + f.partialCount / f.samples,
              0,
            ) / withSamples.length);
    const blendedPFail = 1 - blendedPPass - blendedPPartial;

    return this.normalize({ pPass: blendedPPass, pPartial: blendedPPartial, pFail: blendedPFail });
  }

  /** Normalize distribution to sum to 1.0, clamping negatives. */
  private normalize(d: TestOutcomeDistribution): TestOutcomeDistribution {
    // Clamp negatives
    let pPass = Math.max(0, d.pPass);
    let pPartial = Math.max(0, d.pPartial);
    let pFail = Math.max(0, d.pFail);

    const total = pPass + pPartial + pFail;
    if (total === 0) {
      // Degenerate case — uniform
      return { pPass: 1 / 3, pPartial: 1 / 3, pFail: 1 / 3 };
    }

    pPass /= total;
    pPartial /= total;
    pFail /= total;

    return { pPass, pPartial, pFail };
  }
}
