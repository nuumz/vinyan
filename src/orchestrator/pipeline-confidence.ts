/**
 * Pipeline Confidence — compound uncertainty tracking across the 6-step orchestrator pipeline.
 * Design: docs/research/ehd-implementation-design.md §2.5, §3.1 (geometric mean for pipeline)
 *
 * Steps:
 *   ① Perceive (prediction)
 *   ② Predict (metaPrediction)
 *   ③ Plan (planning)
 *   ④ Generate (generation)
 *   ⑤ Verify (verification) ← This IS the gate-level aggregate
 *   ⑥ Critic (critic)
 */

export interface PipelineConfidence {
  prediction: number; // [0,1] — SelfModel's predicted confidence for this task type
  metaPrediction: number; // [0,1] — confidence in the prediction itself
  planning: number; // [0,1] — task decomposer confidence
  generation: number; // [0,1] — worker generation confidence
  verification: number; // [0,1] — gate-level aggregate (from EpistemicGateVerdict)
  critic: number; // [0,1] — critic assessment confidence
  composite: number; // Weighted geometric mean of above
  formula: string; // Human-readable derivation for audit (A3)
  dataAvailability: {
    predictionAvailable: boolean;
    planningAvailable: boolean;
    criticAvailable: boolean;
  };
}

/** Weights for pipeline composite (verification anchors at 0.40). */
export const PIPELINE_WEIGHTS = {
  prediction: 0.15,
  metaPrediction: 0.05,
  planning: 0.10,
  generation: 0.10,
  verification: 0.40, // Hard evidence dominates
  critic: 0.20,
} as const;

/**
 * Pipeline composite thresholds (PC design, §11).
 * Different from gate-level thresholds — applied to the full 6-step composite.
 */
export const PIPELINE_THRESHOLDS = {
  ALLOW: 0.70, // composite >= 0.70: allow
  RE_VERIFY: 0.50, // 0.50 <= composite < 0.70: re-verify
  ESCALATE: 0.30, // 0.30 <= composite < 0.50: escalate
  REFUSE: 0.00, // composite < 0.30: refuse
} as const;

export type ConfidenceDecision = 'allow' | 're-verify' | 'escalate' | 'refuse';

/** Default neutral value for dimensions that were not explicitly provided. */
const DEFAULT_NEUTRAL = 0.7;

/** NaN sentinel replacement — treat as uncertain neutral. */
const NAN_NEUTRAL = 0.5;

/**
 * Compute composite pipeline confidence using weighted geometric mean.
 * Missing dimensions use their default neutral value (0.7).
 * NaN inputs are treated as 0.5 (uncertain neutral).
 *
 * Formula: composite = exp(Σ wᵢ · ln(vᵢ))
 * Special case: if any dimension is 0, composite = 0 (zero evidence dominates).
 *
 * A3: Formula string is included for deterministic audit trail.
 */
export function computePipelineConfidence(
  partial: Partial<Omit<PipelineConfidence, 'composite' | 'formula' | 'dataAvailability'>>,
): PipelineConfidence {
  const resolve = (v: number | undefined, defaultVal: number): number => {
    if (v === undefined) return defaultVal;
    if (Number.isNaN(v)) return NAN_NEUTRAL;
    return v;
  };

  const prediction = resolve(partial.prediction, DEFAULT_NEUTRAL);
  const metaPrediction = resolve(partial.metaPrediction, DEFAULT_NEUTRAL);
  const planning = resolve(partial.planning, DEFAULT_NEUTRAL);
  const generation = resolve(partial.generation, DEFAULT_NEUTRAL);
  const verification = resolve(partial.verification, DEFAULT_NEUTRAL);
  const critic = resolve(partial.critic, DEFAULT_NEUTRAL);

  const values: [string, number, number][] = [
    ['pred', prediction, PIPELINE_WEIGHTS.prediction],
    ['meta', metaPrediction, PIPELINE_WEIGHTS.metaPrediction],
    ['plan', planning, PIPELINE_WEIGHTS.planning],
    ['gen', generation, PIPELINE_WEIGHTS.generation],
    ['ver', verification, PIPELINE_WEIGHTS.verification],
    ['crit', critic, PIPELINE_WEIGHTS.critic],
  ];

  // Weighted geometric mean: exp(Σ wᵢ·ln(vᵢ))
  // If any value is 0, the product is 0 (0^w = 0 for w > 0)
  let composite: number;
  if (values.some(([, v]) => v === 0)) {
    composite = 0;
  } else {
    const logSum = values.reduce((acc, [, v, w]) => acc + w * Math.log(v), 0);
    composite = Math.exp(logSum);
  }

  // Clamp to [0,1] for floating-point safety
  composite = Math.min(1, Math.max(0, composite));

  const formulaParts = values.map(([label, v, w]) => `${w}·ln(${v.toFixed(3)})[${label}]`).join('+');
  const formula = `composite = exp(${formulaParts}) = ${composite.toFixed(4)}`;

  return {
    prediction,
    metaPrediction,
    planning,
    generation,
    verification,
    critic,
    composite,
    formula,
    dataAvailability: {
      predictionAvailable: 'prediction' in partial || 'metaPrediction' in partial,
      planningAvailable: 'planning' in partial,
      criticAvailable: 'critic' in partial,
    },
  };
}

/**
 * Derive confidence decision from pipeline composite.
 * A3: Deterministic — threshold comparison only.
 *
 *   composite >= ALLOW (0.70)     → 'allow'
 *   composite >= RE_VERIFY (0.50) → 're-verify'
 *   composite >= ESCALATE (0.30)  → 'escalate'
 *   composite <  ESCALATE (0.30)  → 'refuse'
 */
export function deriveConfidenceDecision(composite: number): ConfidenceDecision {
  if (composite >= PIPELINE_THRESHOLDS.ALLOW) return 'allow';
  if (composite >= PIPELINE_THRESHOLDS.RE_VERIFY) return 're-verify';
  if (composite >= PIPELINE_THRESHOLDS.ESCALATE) return 'escalate';
  return 'refuse';
}
