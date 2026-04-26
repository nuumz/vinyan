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

/** Floating-point tolerance for SL invariant checks (internal computation).
 *  Wire-boundary tolerance is wider (0.001) — see SubjectiveOpinionSchema.refine(). */
export const SL_EPSILON = 1e-6;

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
    Math.abs(o.belief + o.disbelief + o.uncertainty - 1) < 0.001, {
    message: 'belief + disbelief + uncertainty must equal 1.0 (±0.001 wire tolerance)',
  });

/**
 * Maps a scalar confidence [0,1] to an SL opinion.
 *
 * When defaultUncertainty > 0, produces a non-dogmatic opinion that honestly
 * represents the epistemic gap from scalar→opinion conversion (A2).
 * When defaultUncertainty = 0 (default), produces a dogmatic opinion (u=0) for
 * backward compatibility. Pass defaultUncertainty > 0 to enable non-dogmatic
 * conversion at the call site.
 */
export function fromScalar(confidence: number, baseRate = 0.5, defaultUncertainty = 0): SubjectiveOpinion {
  const u = Math.max(0, Math.min(1, defaultUncertainty));
  const remaining = 1 - u;
  return {
    belief: confidence * remaining,
    disbelief: (1 - confidence) * remaining,
    uncertainty: u,
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
 * Returns true if |b + d + u - 1| < SL_EPSILON and all components in [0,1].
 */
export function isValid(o: SubjectiveOpinion): boolean {
  return (
    Math.abs(o.belief + o.disbelief + o.uncertainty - 1) < SL_EPSILON &&
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
 * Otherwise, return fromScalar(verdict.confidence, baseRate, defaultUncertainty).
 */
export function resolveOpinion(
  verdict: { confidence: number; opinion?: SubjectiveOpinion },
  baseRate = 0.5,
  defaultUncertainty = 0.3,
): SubjectiveOpinion {
  if (verdict.opinion !== undefined && isValid(verdict.opinion)) {
    return verdict.opinion;
  }
  return fromScalar(verdict.confidence, baseRate, defaultUncertainty);
}

// ---------------------------------------------------------------------------
// Internal: validation tolerance & normalization
// ---------------------------------------------------------------------------

/** Floating-point tolerance for b+d+u=1 check. */
const EPSILON = SL_EPSILON;

function normalize(o: SubjectiveOpinion): SubjectiveOpinion {
  const sum = o.belief + o.disbelief + o.uncertainty;
  if (sum === 0) return vacuous(o.baseRate);
  return {
    belief: o.belief / sum,
    disbelief: o.disbelief / sum,
    uncertainty: o.uncertainty / sum,
    baseRate: o.baseRate,
  };
}

function assertValid(o: SubjectiveOpinion, label: string): void {
  if (!isValid(o)) {
    throw new Error(
      `Invalid SubjectiveOpinion (${label}): b=${o.belief}, d=${o.disbelief}, u=${o.uncertainty}, ` +
        `sum=${o.belief + o.disbelief + o.uncertainty}`,
    );
  }
}

// ---------------------------------------------------------------------------
// 1. Cumulative Fusion (Josang 2016 §12.3)
// ---------------------------------------------------------------------------

/**
 * Cumulative fusion for independent oracle pairs.
 * Reduces uncertainty when both sources carry evidence.
 */
export function cumulativeFusion(a: SubjectiveOpinion, b: SubjectiveOpinion): SubjectiveOpinion {
  assertValid(a, "cumulativeFusion.a");
  assertValid(b, "cumulativeFusion.b");

  const uA = a.uncertainty;
  const uB = b.uncertainty;

  // Both dogmatic — simple average
  if (uA < EPSILON && uB < EPSILON) {
    return normalize({
      belief: (a.belief + b.belief) / 2,
      disbelief: (a.disbelief + b.disbelief) / 2,
      uncertainty: 0,
      baseRate: (a.baseRate + b.baseRate) / 2,
    });
  }

  // Exactly one dogmatic — it overrides
  if (uA < EPSILON) return { ...a };
  if (uB < EPSILON) return { ...b };

  // General case
  const denom = uA + uB - uA * uB;
  return normalize({
    belief: (a.belief * uB + b.belief * uA) / denom,
    disbelief: (a.disbelief * uB + b.disbelief * uA) / denom,
    uncertainty: (uA * uB) / denom,
    baseRate: (a.baseRate * uB + b.baseRate * uA) / (uA + uB),
  });
}

// ---------------------------------------------------------------------------
// 2. Averaging Fusion
// ---------------------------------------------------------------------------

/**
 * Averaging fusion for dependent oracle pairs (shared upstream deps).
 * Does NOT reduce uncertainty beyond the mean of inputs.
 */
export function averagingFusion(a: SubjectiveOpinion, b: SubjectiveOpinion): SubjectiveOpinion {
  assertValid(a, "averagingFusion.a");
  assertValid(b, "averagingFusion.b");

  const uA = a.uncertainty;
  const uB = b.uncertainty;

  // Both dogmatic — simple average
  if (uA < EPSILON && uB < EPSILON) {
    return normalize({
      belief: (a.belief + b.belief) / 2,
      disbelief: (a.disbelief + b.disbelief) / 2,
      uncertainty: 0,
      baseRate: (a.baseRate + b.baseRate) / 2,
    });
  }

  const uSum = uA + uB;
  return normalize({
    belief: (a.belief * uB + b.belief * uA) / uSum,
    disbelief: (a.disbelief * uB + b.disbelief * uA) / uSum,
    uncertainty: (2 * uA * uB) / uSum,
    baseRate: (a.baseRate + b.baseRate) / 2,
  });
}

// ---------------------------------------------------------------------------
// 3. Weighted Fusion
// ---------------------------------------------------------------------------

/**
 * Weighted fusion for partially overlapping dependency sets.
 * Weights are typically derived from tier priority.
 */
export function weightedFusion(
  a: SubjectiveOpinion,
  wa: number,
  b: SubjectiveOpinion,
  wb: number,
): SubjectiveOpinion {
  assertValid(a, "weightedFusion.a");
  assertValid(b, "weightedFusion.b");
  if (wa < 0 || wb < 0) throw new Error("Weights must be non-negative");
  const total = wa + wb;
  if (total === 0) return vacuous((a.baseRate + b.baseRate) / 2);

  return normalize({
    belief: (wa * a.belief + wb * b.belief) / total,
    disbelief: (wa * a.disbelief + wb * b.disbelief) / total,
    uncertainty: (wa * a.uncertainty + wb * b.uncertainty) / total,
    baseRate: (wa * a.baseRate + wb * b.baseRate) / total,
  });
}

// ---------------------------------------------------------------------------
// 4. Conflict Report
// ---------------------------------------------------------------------------

export interface ConflictReport {
  /** Conflict mass: b1*d2 + d1*b2. K=0 means full agreement, K>0.5 means high conflict. */
  K: number;
  /** 'fuse' if K <= 0.5, 'reject' if K > 0.5 (Dempster normalization amplifies >2x). */
  resolution: "fuse" | "reject";
}

export function computeConflictReport(a: SubjectiveOpinion, b: SubjectiveOpinion): ConflictReport {
  const K = a.belief * b.disbelief + a.disbelief * b.belief;
  return { K, resolution: K > 0.5 ? "reject" : "fuse" };
}

// ---------------------------------------------------------------------------
// 5. N-ary Fusion (fuseAll)
// ---------------------------------------------------------------------------

export interface FusionInput {
  opinion: SubjectiveOpinion;
  tier: string; // 'deterministic' | 'heuristic' | 'probabilistic'
  deps: string[]; // dependency file paths (for Jaccard overlap)
}

/** Tier priority order (deterministic first; lower number = higher priority). */
const TIER_PRIORITY: Record<string, number> = {
  deterministic: 0,
  heuristic: 1,
  pragmatic: 2,
  probabilistic: 3,
};

/** Tier weights for weighted fusion. */
const TIER_WEIGHT: Record<string, number> = {
  deterministic: 1.0,
  heuristic: 0.6,
  pragmatic: 0.45,
  probabilistic: 0.3,
};

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const x of setA) {
    if (setB.has(x)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Fuse N oracle opinions using Jaccard dep-set overlap to select the
 * appropriate fusion operator per pair.
 *
 * Algorithm:
 * 1. Sort inputs by tier priority (deterministic first).
 * 2. Accumulate by fusing pairwise, selecting operator by Jaccard overlap
 *    between each input's deps and the FIRST input's deps.
 * 3. Skip inputs whose conflict K > 0.5 with the accumulator.
 * 4. If all are skipped, return vacuous().
 */
export function fuseAll(inputs: FusionInput[]): SubjectiveOpinion {
  if (inputs.length === 0) return vacuous();

  // Sort by tier priority (stable sort preserves insertion order within same tier)
  const sorted = [...inputs].sort(
    (x, y) => (TIER_PRIORITY[x.tier] ?? 99) - (TIER_PRIORITY[y.tier] ?? 99),
  );

  if (sorted.length === 1) return { ...sorted[0]!.opinion };

  const firstDeps = sorted[0]!.deps;
  let acc = { ...sorted[0]!.opinion };
  let anyFused = false;

  for (let i = 1; i < sorted.length; i++) {
    const input = sorted[i]!;

    // Conflict check against accumulator
    const report = computeConflictReport(acc, input.opinion);
    if (report.resolution === "reject") continue;

    // Select operator by Jaccard overlap with first input's deps
    const j = jaccard(firstDeps, input.deps);

    if (j > 0.5) {
      acc = averagingFusion(acc, input.opinion);
    } else if (j === 0) {
      acc = cumulativeFusion(acc, input.opinion);
    } else {
      const wAcc = TIER_WEIGHT[sorted[0]!.tier] ?? 0.3;
      const wInput = TIER_WEIGHT[input.tier] ?? 0.3;
      acc = weightedFusion(acc, wAcc, input.opinion, wInput);
    }
    anyFused = true;
  }

  if (!anyFused && sorted.length > 1) return vacuous();

  return acc;
}

// ---------------------------------------------------------------------------
// 6. Clamp Opinion By Tier
// ---------------------------------------------------------------------------

const TIER_U_FLOORS: Record<string, number> = {
  deterministic: 0.01,
  heuristic: 0.10,
  pragmatic: 0.18,
  probabilistic: 0.25,
};

/**
 * Enforce an uncertainty floor by tier. NEVER decreases u.
 * If u < floor, redistributes proportionally from b and d to meet the floor.
 */
export function clampOpinionByTier(o: SubjectiveOpinion, tier: string): SubjectiveOpinion {
  const floor = TIER_U_FLOORS[tier];
  if (floor === undefined) return { ...o };
  if (o.uncertainty >= floor) return { ...o };

  const deficit = floor - o.uncertainty;
  const bd = o.belief + o.disbelief;

  // If b+d is essentially 0, just set u to floor (edge case: all zero after rounding)
  if (bd < EPSILON) {
    return { belief: 0, disbelief: 0, uncertainty: floor, baseRate: o.baseRate };
  }

  // Redistribute proportionally from b and d
  const scale = (bd - deficit) / bd;
  return normalize({
    belief: o.belief * scale,
    disbelief: o.disbelief * scale,
    uncertainty: floor,
    baseRate: o.baseRate,
  });
}

// ---------------------------------------------------------------------------
// 7. Temporal Decay
// ---------------------------------------------------------------------------

/**
 * Apply temporal decay — uncertainty grows over time, modeling evidence staleness.
 *
 * @param o          - The opinion to decay
 * @param elapsedMs  - Time elapsed since evidence was gathered
 * @param halfLifeMs - Half-life for the decay model
 * @param decayModel - 'linear' | 'step' | 'none' | 'exponential'
 */
export function temporalDecay(
  o: SubjectiveOpinion,
  elapsedMs: number,
  halfLifeMs: number,
  decayModel: "linear" | "step" | "none" | "exponential",
): SubjectiveOpinion {
  if (decayModel === "none") return { ...o };

  if (decayModel === "step") {
    if (elapsedMs >= halfLifeMs) return vacuous(o.baseRate);
    return { ...o };
  }

  if (decayModel === "exponential") {
    if (elapsedMs <= 0 || halfLifeMs <= 0) return { ...o };
    const oldCertainty = 1 - o.uncertainty;
    if (oldCertainty <= 0) return { ...o };
    const decay = 2 ** (-elapsedMs / halfLifeMs);
    const newCertainty = oldCertainty * decay;
    const scale = newCertainty / oldCertainty;
    return {
      belief: o.belief * scale,
      disbelief: o.disbelief * scale,
      uncertainty: 1 - newCertainty,
      baseRate: o.baseRate,
    };
  }

  // Linear decay: uncertainty grows linearly toward 1.0 over 2 * halfLife
  const decayFactor = Math.min(1, elapsedMs / (2 * halfLifeMs));
  const uNew = o.uncertainty + (1 - o.uncertainty) * decayFactor;

  // Scale b and d proportionally so b + d + uNew = 1
  const bdOld = o.belief + o.disbelief;
  if (bdOld < EPSILON) {
    return { belief: 0, disbelief: 0, uncertainty: uNew, baseRate: o.baseRate };
  }

  const bdNew = 1 - uNew;
  const scale = bdNew / bdOld;
  return {
    belief: o.belief * scale,
    disbelief: o.disbelief * scale,
    uncertainty: uNew,
    baseRate: o.baseRate,
  };
}

// ---------------------------------------------------------------------------
// 8. Exponential Decay (toward vacuous)
// ---------------------------------------------------------------------------

/**
 * Temporal decay: opinion drifts toward vacuous over time.
 * Uses exponential decay: uncertainty increases as evidence ages.
 *
 * @deprecated Use `temporalDecay(opinion, elapsedMs, halfLifeMs, 'exponential')` instead.
 * This function is retained for backward compatibility and will be removed in a future version.
 *
 * @param opinion - The opinion to decay
 * @param elapsedMs - Time elapsed since opinion was formed (ms)
 * @param halfLifeMs - Half-life: time for uncertainty to reach midpoint (ms)
 * @returns Decayed opinion (closer to vacuous as time passes)
 */
export function decayOpinion(
  opinion: SubjectiveOpinion,
  elapsedMs: number,
  halfLifeMs: number,
): SubjectiveOpinion {
  if (elapsedMs <= 0 || halfLifeMs <= 0) return { ...opinion };

  const oldCertainty = 1 - opinion.uncertainty;
  if (oldCertainty <= 0) return { ...opinion }; // Already vacuous

  const decayFactor = 2 ** (-elapsedMs / halfLifeMs);
  const newCertainty = oldCertainty * decayFactor;
  const newUncertainty = 1 - newCertainty;

  // Proportionally rescale belief and disbelief
  const scale = newCertainty / oldCertainty;
  return {
    belief: opinion.belief * scale,
    disbelief: opinion.disbelief * scale,
    uncertainty: newUncertainty,
    baseRate: opinion.baseRate,
  };
}

// ---------------------------------------------------------------------------
// 9. EMA-based Base Rate Calibration
// ---------------------------------------------------------------------------

/**
 * EMA-based base rate calibration from observed outcomes.
 * Updates the base rate toward the observed success rate.
 *
 * Only calibrates when sufficient data exists (≥ minSamples).
 * Uses exponential moving average for smooth adaptation.
 *
 * @param currentBaseRate - Current a priori base rate
 * @param observedSuccessRate - Fraction of verdicts confirmed correct [0,1]
 * @param totalSamples - Number of resolved verdicts
 * @param minSamples - Minimum samples before calibration kicks in (default: 30)
 * @param alpha - EMA smoothing factor (default: 0.1 — slow adaptation)
 * @returns Calibrated base rate
 */
export function calibrateBaseRate(
  currentBaseRate: number,
  observedSuccessRate: number,
  totalSamples: number,
  minSamples = 30,
  alpha = 0.1,
): number {
  if (totalSamples < minSamples) return currentBaseRate;
  // EMA: newRate = (1 - alpha) * currentRate + alpha * observed
  return (1 - alpha) * currentBaseRate + alpha * observedSuccessRate;
}
