/**
 * HMS Risk Scorer — aggregate hallucination signals into composite risk.
 *
 * A3 compliant: deterministic weighted formula.
 * Modulates pipeline.verification dimension (weight 0.40) — higher risk = lower confidence.
 *
 * Source of truth: HMS plan §H2 (HMS-3)
 */
import type { GroundingResult } from './claim-grounding.ts';
import type { OverconfidenceSignals } from './overconfidence-detector.ts';

export interface CrossValidationResult {
  consistency: number;
  probes_sent: number;
}

export interface HallucinationRiskInput {
  groundingResult?: GroundingResult;
  overconfidence?: OverconfidenceSignals;
  oraclePassRatio: number;
  criticConfidence?: number;
  crossValidation?: CrossValidationResult;
}

export interface HallucinationRisk {
  score: number;
  primary_signal: string;
  signals: Record<string, number>;
}

export interface RiskWeights {
  grounding: number;
  overconfidence: number;
  structural: number;
  critic: number;
  cross_validation: number;
}

const DEFAULT_WEIGHTS: RiskWeights = {
  grounding: 0.35,
  overconfidence: 0.15,
  structural: 0.25,
  critic: 0.15,
  cross_validation: 0.1,
};

/**
 * Compute composite hallucination risk score.
 * Pure function — A3 compliant.
 */
export function computeHallucinationRisk(
  input: HallucinationRiskInput,
  weights: RiskWeights = DEFAULT_WEIGHTS,
): HallucinationRisk {
  const signals: Record<string, number> = {};

  // Grounding risk: 1 - grounding_ratio (refuted claims = high risk)
  signals.grounding = input.groundingResult ? 1 - input.groundingResult.grounding_ratio : 0;

  // Overconfidence risk
  signals.overconfidence = input.overconfidence?.score ?? 0;

  // Structural risk: 1 - oracle pass ratio
  signals.structural = 1 - Math.min(1, Math.max(0, input.oraclePassRatio));

  // Critic risk: 1 - critic confidence
  signals.critic = 1 - (input.criticConfidence ?? 0.7);

  // Cross-validation risk: 1 - consistency
  signals.cross_validation = input.crossValidation ? 1 - input.crossValidation.consistency : 0;

  // Weighted sum
  const score = Math.min(
    1.0,
    Math.max(
      0,
      weights.grounding * signals.grounding +
        weights.overconfidence * signals.overconfidence +
        weights.structural * signals.structural +
        weights.critic * signals.critic +
        weights.cross_validation * signals.cross_validation,
    ),
  );

  // Find primary signal
  let maxSignal = '';
  let maxValue = -1;
  for (const [key, value] of Object.entries(signals)) {
    const weighted = value * (weights[key as keyof RiskWeights] ?? 0);
    if (weighted > maxValue) {
      maxValue = weighted;
      maxSignal = key;
    }
  }

  return { score, primary_signal: maxSignal, signals };
}

/**
 * Apply hallucination risk to verification confidence.
 * Returns adjusted confidence — higher risk = lower confidence.
 *
 * Attenuation: adjusted = original × (1 - risk × 0.5)
 * At max risk (1.0), verification drops by 50%.
 */
export function attenuateConfidence(verificationConfidence: number, risk: HallucinationRisk): number {
  return verificationConfidence * (1 - risk.score * 0.5);
}
