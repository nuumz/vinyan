/**
 * Subjective Logic opinion tuple (Josang, 2016).
 * A2: First-Class Uncertainty — "I don't know" is a valid state, not an error.
 *
 * Invariants:
 *   b + d + u = 1.0  (±1e-9 tolerance)
 *   0 <= b, d, u <= 1
 *   0 < a < 1
 *
 * Projected probability: P = b + a * u
 * When u = 0, reduces to standard probability.
 * When u = 1, reduces to prior (a).
 */
import { z } from 'zod';

export interface SubjectiveOpinion {
  /** Belief mass: evidence FOR the proposition */
  belief: number;
  /** Disbelief mass: evidence AGAINST the proposition */
  disbelief: number;
  /** Uncertainty mass: lack of evidence */
  uncertainty: number;
  /** Base rate (prior probability) — used when uncertainty > 0 */
  baseRate: number;
}

/** Zod schema for SubjectiveOpinion validation */
export const SubjectiveOpinionSchema: z.ZodType<SubjectiveOpinion> = z
  .object({
    belief: z.number().min(0).max(1),
    disbelief: z.number().min(0).max(1),
    uncertainty: z.number().min(0).max(1),
    baseRate: z.number().min(0).max(1),
  })
  .refine((o: { belief: number; disbelief: number; uncertainty: number; baseRate: number }) =>
    Math.abs(o.belief + o.disbelief + o.uncertainty - 1) < 1e-9, {
    message: 'belief + disbelief + uncertainty must equal 1.0 (±1e-9)',
  });

/**
 * Maps a scalar confidence [0,1] to a dogmatic opinion (u=0, d=1-b, b=confidence).
 * baseRate defaults to 0.5.
 */
export function fromScalar(confidence: number, baseRate = 0.5): SubjectiveOpinion {
  return {
    belief: confidence,
    disbelief: 1 - confidence,
    uncertainty: 0,
    baseRate,
  };
}

/**
 * Returns the projected probability: b + a * u.
 * This is the expected value of the opinion.
 */
export function projectedProbability(o: SubjectiveOpinion): number {
  return o.belief + o.baseRate * o.uncertainty;
}

/**
 * Returns a vacuous opinion — maximum uncertainty, no evidence at all.
 * In SL terms: {b=0, d=0, u=1, a=baseRate}.
 */
export function vacuous(baseRate = 0.5): SubjectiveOpinion {
  return { belief: 0, disbelief: 0, uncertainty: 1, baseRate };
}

/**
 * Returns a dogmatic opinion — full certainty, no uncertainty.
 * {belief, disbelief: 1-belief, uncertainty: 0, baseRate}
 */
export function dogmatic(belief: number, baseRate = 0.5): SubjectiveOpinion {
  return { belief, disbelief: 1 - belief, uncertainty: 0, baseRate };
}

/**
 * Returns true if o.uncertainty > threshold (default 0.95).
 */
export function isVacuous(o: SubjectiveOpinion, threshold = 0.95): boolean {
  return o.uncertainty > threshold;
}

/**
 * Returns true if |b + d + u - 1| < 1e-9 and all components in [0,1].
 */
export function isValid(o: SubjectiveOpinion): boolean {
  return (
    Math.abs(o.belief + o.disbelief + o.uncertainty - 1) < 1e-9 &&
    o.belief >= 0 &&
    o.belief <= 1 &&
    o.disbelief >= 0 &&
    o.disbelief <= 1 &&
    o.uncertainty >= 0 &&
    o.uncertainty <= 1
  );
}

/**
 * If verdict.opinion is present AND isValid(opinion), return it.
 * Otherwise, return fromScalar(verdict.confidence, baseRate).
 */
export function resolveOpinion(
  verdict: { confidence: number; opinion?: SubjectiveOpinion },
  baseRate = 0.5,
): SubjectiveOpinion {
  if (verdict.opinion !== undefined && isValid(verdict.opinion)) {
    return verdict.opinion;
  }
  return fromScalar(verdict.confidence, baseRate);
}
