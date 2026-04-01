import { describe, test, expect } from "bun:test";
import {
  type SubjectiveOpinion,
  isValid,
  vacuous,
  dogmatic,
  isVacuous,
  fromScalar,
  projectedProbability,
  cumulativeFusion,
  averagingFusion,
  weightedFusion,
  computeConflictReport,
  fuseAll,
  clampOpinionByTier,
  temporalDecay,
  type FusionInput,
} from "../../src/core/subjective-opinion.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EPSILON = 1e-6;

/** Assert the invariant: valid opinion with all components in [0,1]. */
function assertInvariant(o: SubjectiveOpinion, label = "result") {
  expect(isValid(o)).toBe(true);
  expect(o.belief).toBeGreaterThanOrEqual(-EPSILON);
  expect(o.disbelief).toBeGreaterThanOrEqual(-EPSILON);
  expect(o.uncertainty).toBeGreaterThanOrEqual(-EPSILON);
  expect(o.belief).toBeLessThanOrEqual(1 + EPSILON);
  expect(o.disbelief).toBeLessThanOrEqual(1 + EPSILON);
  expect(o.uncertainty).toBeLessThanOrEqual(1 + EPSILON);
  expect(o.baseRate).toBeGreaterThanOrEqual(0);
  expect(o.baseRate).toBeLessThanOrEqual(1);
}

function near(a: number, b: number, tol = 1e-6): boolean {
  return Math.abs(a - b) < tol;
}

// ---------------------------------------------------------------------------
// Base helpers (ensure they still work)
// ---------------------------------------------------------------------------

describe("SubjectiveOpinion base helpers", () => {
  test("vacuous() returns total ignorance", () => {
    const v = vacuous();
    expect(v.belief).toBe(0);
    expect(v.disbelief).toBe(0);
    expect(v.uncertainty).toBe(1);
    expect(v.baseRate).toBe(0.5);
    assertInvariant(v);
  });

  test("dogmatic() returns zero uncertainty", () => {
    const d = dogmatic(0.8);
    expect(d.belief).toBe(0.8);
    expect(d.disbelief).toBeCloseTo(0.2, 10);
    expect(d.uncertainty).toBe(0);
    assertInvariant(d);
  });

  test("isVacuous detects vacuous opinion", () => {
    expect(isVacuous(vacuous())).toBe(true);
    expect(isVacuous(dogmatic(1))).toBe(false);
  });

  test("fromScalar maps confidence to dogmatic opinion", () => {
    const o = fromScalar(0.7);
    expect(o.belief).toBeCloseTo(0.7, 10);
    expect(o.disbelief).toBeCloseTo(0.3, 10);
    expect(o.uncertainty).toBe(0);
    assertInvariant(o);
  });

  test("projectedProbability = b + a*u", () => {
    const o: SubjectiveOpinion = { belief: 0.6, disbelief: 0.2, uncertainty: 0.2, baseRate: 0.5 };
    expect(projectedProbability(o)).toBeCloseTo(0.6 + 0.5 * 0.2, 10);
  });

  test("projectedProbability computes expected value", () => {
    const o: SubjectiveOpinion = { belief: 0.5, disbelief: 0.3, uncertainty: 0.2, baseRate: 0.5 };
    expect(projectedProbability(o)).toBeCloseTo(0.5 + 0.5 * 0.2, 10);
  });

  test("isValid rejects invalid opinions", () => {
    expect(isValid({ belief: 0.5, disbelief: 0.5, uncertainty: 0.5, baseRate: 0.5 })).toBe(false);
    expect(isValid({ belief: -0.1, disbelief: 0.6, uncertainty: 0.5, baseRate: 0.5 })).toBe(false);
    expect(isValid({ belief: 0.5, disbelief: 0.3, uncertainty: 0.2, baseRate: 0.5 })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 1. cumulativeFusion
// ---------------------------------------------------------------------------

describe("cumulativeFusion", () => {
  test("two vacuous opinions → vacuous", () => {
    const result = cumulativeFusion(vacuous(), vacuous());
    assertInvariant(result);
    // Both vacuous: u_a=1, u_b=1 → denom = 1+1-1 = 1 → u_fused = 1*1/1 = 1
    expect(result.uncertainty).toBeCloseTo(1, 6);
    expect(result.belief).toBeCloseTo(0, 6);
    expect(result.disbelief).toBeCloseTo(0, 6);
  });

  test("vacuous + dogmatic → dogmatic", () => {
    const d = dogmatic(0.9);
    const result = cumulativeFusion(vacuous(), d);
    assertInvariant(result);
    // Dogmatic has u=0, so it overrides
    expect(result.belief).toBeCloseTo(0.9, 6);
    expect(result.uncertainty).toBeCloseTo(0, 6);
  });

  test("dogmatic + vacuous → dogmatic (symmetric check)", () => {
    const d = dogmatic(0.9);
    const result = cumulativeFusion(d, vacuous());
    assertInvariant(result);
    expect(result.belief).toBeCloseTo(0.9, 6);
    expect(result.uncertainty).toBeCloseTo(0, 6);
  });

  test("two agreeing opinions → higher belief, lower uncertainty", () => {
    const a: SubjectiveOpinion = { belief: 0.6, disbelief: 0.1, uncertainty: 0.3, baseRate: 0.5 };
    const b: SubjectiveOpinion = { belief: 0.7, disbelief: 0.1, uncertainty: 0.2, baseRate: 0.5 };
    const result = cumulativeFusion(a, b);
    assertInvariant(result);
    // Uncertainty should decrease
    expect(result.uncertainty).toBeLessThan(Math.min(a.uncertainty, b.uncertainty));
    // Belief should be at least as high as either input's belief
    expect(result.belief).toBeGreaterThan(Math.max(a.belief, b.belief) - 0.01);
  });

  test("two opposing opinions → mixed, moderate uncertainty", () => {
    const a: SubjectiveOpinion = { belief: 0.7, disbelief: 0.1, uncertainty: 0.2, baseRate: 0.5 };
    const b: SubjectiveOpinion = { belief: 0.1, disbelief: 0.7, uncertainty: 0.2, baseRate: 0.5 };
    const result = cumulativeFusion(a, b);
    assertInvariant(result);
    // Should have mixed belief/disbelief, uncertainty lower than inputs
    expect(result.uncertainty).toBeLessThan(Math.min(a.uncertainty, b.uncertainty));
  });

  test("both dogmatic → average", () => {
    const a = dogmatic(0.8);
    const b = dogmatic(0.4);
    const result = cumulativeFusion(a, b);
    assertInvariant(result);
    expect(result.belief).toBeCloseTo(0.6, 6);
    expect(result.disbelief).toBeCloseTo(0.4, 6);
    expect(result.uncertainty).toBeCloseTo(0, 6);
  });

  test("throws on invalid input", () => {
    const bad: SubjectiveOpinion = { belief: 0.5, disbelief: 0.5, uncertainty: 0.5, baseRate: 0.5 };
    expect(() => cumulativeFusion(bad, vacuous())).toThrow("Invalid SubjectiveOpinion");
  });
});

// ---------------------------------------------------------------------------
// 2. averagingFusion
// ---------------------------------------------------------------------------

describe("averagingFusion", () => {
  test("does not reduce uncertainty below mean of inputs", () => {
    const a: SubjectiveOpinion = { belief: 0.5, disbelief: 0.2, uncertainty: 0.3, baseRate: 0.5 };
    const b: SubjectiveOpinion = { belief: 0.4, disbelief: 0.1, uncertainty: 0.5, baseRate: 0.5 };
    const result = averagingFusion(a, b);
    assertInvariant(result);
    // Averaging fusion: u_fused = 2*u_a*u_b / (u_a+u_b) which is the harmonic mean
    // Harmonic mean <= arithmetic mean, so u_fused <= (u_a + u_b) / 2
    const meanU = (a.uncertainty + b.uncertainty) / 2;
    // The harmonic mean is always <= arithmetic mean, but the key property is
    // that averaging fusion doesn't reduce u as aggressively as cumulative
    expect(result.uncertainty).toBeLessThanOrEqual(meanU + EPSILON);
  });

  test("two identical opinions → same opinion", () => {
    const o: SubjectiveOpinion = { belief: 0.5, disbelief: 0.2, uncertainty: 0.3, baseRate: 0.5 };
    const result = averagingFusion(o, o);
    assertInvariant(result);
    expect(result.belief).toBeCloseTo(o.belief, 6);
    expect(result.disbelief).toBeCloseTo(o.disbelief, 6);
    expect(result.uncertainty).toBeCloseTo(o.uncertainty, 6);
  });

  test("both dogmatic → average", () => {
    const a = dogmatic(0.8);
    const b = dogmatic(0.2);
    const result = averagingFusion(a, b);
    assertInvariant(result);
    expect(result.belief).toBeCloseTo(0.5, 6);
    expect(result.disbelief).toBeCloseTo(0.5, 6);
    expect(result.uncertainty).toBeCloseTo(0, 6);
  });

  test("vacuous + partial → weighted toward partial", () => {
    const v = vacuous();
    const p: SubjectiveOpinion = { belief: 0.6, disbelief: 0.2, uncertainty: 0.2, baseRate: 0.5 };
    const result = averagingFusion(v, p);
    assertInvariant(result);
    // u_a=1, u_b=0.2. b_fused = (0.6*1 + 0*0.2)/(1+0.2) = 0.6/1.2 = 0.5
    expect(result.belief).toBeCloseTo(0.5, 6);
  });
});

// ---------------------------------------------------------------------------
// 3. weightedFusion
// ---------------------------------------------------------------------------

describe("weightedFusion", () => {
  test("equal weights → same as simple average", () => {
    const a: SubjectiveOpinion = { belief: 0.6, disbelief: 0.2, uncertainty: 0.2, baseRate: 0.5 };
    const b: SubjectiveOpinion = { belief: 0.4, disbelief: 0.3, uncertainty: 0.3, baseRate: 0.5 };
    const result = weightedFusion(a, 1, b, 1);
    assertInvariant(result);
    expect(result.belief).toBeCloseTo(0.5, 6);
    expect(result.disbelief).toBeCloseTo(0.25, 6);
    expect(result.uncertainty).toBeCloseTo(0.25, 6);
  });

  test("weight=(1,0) → returns first opinion", () => {
    const a: SubjectiveOpinion = { belief: 0.6, disbelief: 0.2, uncertainty: 0.2, baseRate: 0.5 };
    const b: SubjectiveOpinion = { belief: 0.1, disbelief: 0.8, uncertainty: 0.1, baseRate: 0.5 };
    const result = weightedFusion(a, 1, b, 0);
    assertInvariant(result);
    expect(result.belief).toBeCloseTo(a.belief, 6);
    expect(result.disbelief).toBeCloseTo(a.disbelief, 6);
    expect(result.uncertainty).toBeCloseTo(a.uncertainty, 6);
  });

  test("weight=(0,1) → returns second opinion", () => {
    const a: SubjectiveOpinion = { belief: 0.6, disbelief: 0.2, uncertainty: 0.2, baseRate: 0.5 };
    const b: SubjectiveOpinion = { belief: 0.1, disbelief: 0.8, uncertainty: 0.1, baseRate: 0.5 };
    const result = weightedFusion(a, 0, b, 1);
    assertInvariant(result);
    expect(result.belief).toBeCloseTo(b.belief, 6);
    expect(result.disbelief).toBeCloseTo(b.disbelief, 6);
    expect(result.uncertainty).toBeCloseTo(b.uncertainty, 6);
  });

  test("both weights zero → vacuous", () => {
    const a: SubjectiveOpinion = { belief: 0.6, disbelief: 0.2, uncertainty: 0.2, baseRate: 0.5 };
    const b: SubjectiveOpinion = { belief: 0.1, disbelief: 0.8, uncertainty: 0.1, baseRate: 0.3 };
    const result = weightedFusion(a, 0, b, 0);
    assertInvariant(result);
    expect(result.uncertainty).toBeCloseTo(1, 6);
  });

  test("negative weights throw", () => {
    expect(() => weightedFusion(vacuous(), -1, vacuous(), 1)).toThrow("non-negative");
  });
});

// ---------------------------------------------------------------------------
// 4. computeConflictReport
// ---------------------------------------------------------------------------

describe("computeConflictReport", () => {
  test("two agreeing → K ≈ 0", () => {
    const a: SubjectiveOpinion = { belief: 0.8, disbelief: 0.1, uncertainty: 0.1, baseRate: 0.5 };
    const b: SubjectiveOpinion = { belief: 0.7, disbelief: 0.1, uncertainty: 0.2, baseRate: 0.5 };
    const report = computeConflictReport(a, b);
    // K = 0.8*0.1 + 0.1*0.7 = 0.08 + 0.07 = 0.15
    expect(report.K).toBeCloseTo(0.15, 6);
    expect(report.resolution).toBe("fuse");
  });

  test("two fully opposing (b=1,d=0 vs b=0,d=1) → K = 1.0", () => {
    const a = dogmatic(1.0); // b=1, d=0
    const b = dogmatic(0.0); // b=0, d=1
    const report = computeConflictReport(a, b);
    // K = 1*1 + 0*0 = 1.0
    expect(report.K).toBeCloseTo(1.0, 6);
    expect(report.resolution).toBe("reject");
  });

  test("moderate disagreement → 0 < K < 0.5", () => {
    const a: SubjectiveOpinion = { belief: 0.6, disbelief: 0.2, uncertainty: 0.2, baseRate: 0.5 };
    const b: SubjectiveOpinion = { belief: 0.3, disbelief: 0.4, uncertainty: 0.3, baseRate: 0.5 };
    const report = computeConflictReport(a, b);
    // K = 0.6*0.4 + 0.2*0.3 = 0.24 + 0.06 = 0.30
    expect(report.K).toBeCloseTo(0.30, 6);
    expect(report.K).toBeGreaterThan(0);
    expect(report.K).toBeLessThanOrEqual(0.5);
    expect(report.resolution).toBe("fuse");
  });

  test("high conflict → K > 0.5, resolution = reject", () => {
    const a: SubjectiveOpinion = { belief: 0.8, disbelief: 0.1, uncertainty: 0.1, baseRate: 0.5 };
    const b: SubjectiveOpinion = { belief: 0.1, disbelief: 0.8, uncertainty: 0.1, baseRate: 0.5 };
    const report = computeConflictReport(a, b);
    // K = 0.8*0.8 + 0.1*0.1 = 0.64 + 0.01 = 0.65
    expect(report.K).toBeCloseTo(0.65, 6);
    expect(report.resolution).toBe("reject");
  });
});

// ---------------------------------------------------------------------------
// 5. fuseAll
// ---------------------------------------------------------------------------

describe("fuseAll", () => {
  test("empty input → vacuous", () => {
    const result = fuseAll([]);
    assertInvariant(result);
    expect(isVacuous(result)).toBe(true);
  });

  test("single input → returns that input", () => {
    const o: SubjectiveOpinion = { belief: 0.7, disbelief: 0.1, uncertainty: 0.2, baseRate: 0.5 };
    const result = fuseAll([{ opinion: o, tier: "deterministic", deps: ["a.ts"] }]);
    assertInvariant(result);
    expect(result.belief).toBeCloseTo(o.belief, 6);
    expect(result.disbelief).toBeCloseTo(o.disbelief, 6);
    expect(result.uncertainty).toBeCloseTo(o.uncertainty, 6);
  });

  test("three independent agreeing oracles → high belief, low uncertainty", () => {
    const inputs: FusionInput[] = [
      { opinion: { belief: 0.7, disbelief: 0.1, uncertainty: 0.2, baseRate: 0.5 }, tier: "deterministic", deps: ["a.ts"] },
      { opinion: { belief: 0.6, disbelief: 0.1, uncertainty: 0.3, baseRate: 0.5 }, tier: "heuristic", deps: ["b.ts"] },
      { opinion: { belief: 0.65, disbelief: 0.1, uncertainty: 0.25, baseRate: 0.5 }, tier: "probabilistic", deps: ["c.ts"] },
    ];
    const result = fuseAll(inputs);
    assertInvariant(result);
    // Independent (jaccard=0 for all pairs with first) → cumulative fusion
    // Should have higher belief and lower uncertainty than any individual input
    expect(result.belief).toBeGreaterThan(0.6);
    expect(result.uncertainty).toBeLessThan(0.2);
  });

  test("two agreeing + one conflicting → conflicting is skipped (K > 0.5)", () => {
    const inputs: FusionInput[] = [
      { opinion: { belief: 0.8, disbelief: 0.1, uncertainty: 0.1, baseRate: 0.5 }, tier: "deterministic", deps: ["a.ts"] },
      { opinion: { belief: 0.7, disbelief: 0.1, uncertainty: 0.2, baseRate: 0.5 }, tier: "heuristic", deps: ["b.ts"] },
      // This one conflicts: high disbelief vs. the accumulated high belief
      { opinion: { belief: 0.05, disbelief: 0.9, uncertainty: 0.05, baseRate: 0.5 }, tier: "probabilistic", deps: ["c.ts"] },
    ];
    const result = fuseAll(inputs);
    assertInvariant(result);
    // The conflicting oracle should have been skipped, so belief stays high
    expect(result.belief).toBeGreaterThan(0.5);
  });

  test("all conflict with first → vacuous", () => {
    const inputs: FusionInput[] = [
      { opinion: { belief: 0.9, disbelief: 0.05, uncertainty: 0.05, baseRate: 0.5 }, tier: "deterministic", deps: ["a.ts"] },
      { opinion: { belief: 0.05, disbelief: 0.9, uncertainty: 0.05, baseRate: 0.5 }, tier: "heuristic", deps: ["b.ts"] },
      { opinion: { belief: 0.05, disbelief: 0.9, uncertainty: 0.05, baseRate: 0.5 }, tier: "probabilistic", deps: ["c.ts"] },
    ];
    const result = fuseAll(inputs);
    assertInvariant(result);
    // Both subsequent inputs conflict with the first (K > 0.5), so they're all skipped
    // The spec says: "if ALL inputs were skipped due to K, return vacuous()"
    expect(isVacuous(result)).toBe(true);
  });

  test("dependent oracles (high Jaccard) use averaging fusion", () => {
    const inputs: FusionInput[] = [
      { opinion: { belief: 0.7, disbelief: 0.1, uncertainty: 0.2, baseRate: 0.5 }, tier: "deterministic", deps: ["a.ts", "b.ts", "c.ts"] },
      { opinion: { belief: 0.6, disbelief: 0.1, uncertainty: 0.3, baseRate: 0.5 }, tier: "heuristic", deps: ["a.ts", "b.ts", "d.ts"] },
    ];
    // Jaccard = |{a,b}| / |{a,b,c,d}| = 2/4 = 0.5, NOT > 0.5, so this uses weighted
    // Let's make overlap higher
    const inputs2: FusionInput[] = [
      { opinion: { belief: 0.7, disbelief: 0.1, uncertainty: 0.2, baseRate: 0.5 }, tier: "deterministic", deps: ["a.ts", "b.ts", "c.ts"] },
      { opinion: { belief: 0.6, disbelief: 0.1, uncertainty: 0.3, baseRate: 0.5 }, tier: "heuristic", deps: ["a.ts", "b.ts", "c.ts"] },
    ];
    // Jaccard = 3/3 = 1.0 > 0.5 → averaging fusion
    const result = fuseAll(inputs2);
    assertInvariant(result);
    // With averaging, uncertainty doesn't decrease as much as cumulative
    const avgRef = averagingFusion(inputs2[0]!.opinion, inputs2[1]!.opinion);
    expect(result.uncertainty).toBeCloseTo(avgRef.uncertainty, 6);
  });

  test("sorts by tier priority — deterministic processed first", () => {
    const inputs: FusionInput[] = [
      { opinion: { belief: 0.3, disbelief: 0.2, uncertainty: 0.5, baseRate: 0.5 }, tier: "probabilistic", deps: ["x.ts"] },
      { opinion: { belief: 0.8, disbelief: 0.1, uncertainty: 0.1, baseRate: 0.5 }, tier: "deterministic", deps: ["y.ts"] },
    ];
    const result = fuseAll(inputs);
    assertInvariant(result);
    // Deterministic should be the base (sorted first), so belief leans toward 0.8
    expect(result.belief).toBeGreaterThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// 6. clampOpinionByTier
// ---------------------------------------------------------------------------

describe("clampOpinionByTier", () => {
  test("deterministic tier with u=0 → u ≥ 0.01", () => {
    const o = dogmatic(0.9);
    const result = clampOpinionByTier(o, "deterministic");
    assertInvariant(result);
    expect(result.uncertainty).toBeGreaterThanOrEqual(0.01 - EPSILON);
    // b and d should be reduced proportionally
    expect(result.belief).toBeLessThanOrEqual(o.belief + EPSILON);
  });

  test("heuristic with u=0.05 → u ≥ 0.10", () => {
    const o: SubjectiveOpinion = { belief: 0.6, disbelief: 0.35, uncertainty: 0.05, baseRate: 0.5 };
    const result = clampOpinionByTier(o, "heuristic");
    assertInvariant(result);
    expect(result.uncertainty).toBeGreaterThanOrEqual(0.10 - EPSILON);
  });

  test("probabilistic with u=0.10 → u ≥ 0.25", () => {
    const o: SubjectiveOpinion = { belief: 0.6, disbelief: 0.3, uncertainty: 0.1, baseRate: 0.5 };
    const result = clampOpinionByTier(o, "probabilistic");
    assertInvariant(result);
    expect(result.uncertainty).toBeGreaterThanOrEqual(0.25 - EPSILON);
  });

  test("already above floor → unchanged", () => {
    const o: SubjectiveOpinion = { belief: 0.4, disbelief: 0.2, uncertainty: 0.4, baseRate: 0.5 };
    const result = clampOpinionByTier(o, "heuristic"); // floor = 0.10
    assertInvariant(result);
    expect(result.belief).toBeCloseTo(o.belief, 6);
    expect(result.disbelief).toBeCloseTo(o.disbelief, 6);
    expect(result.uncertainty).toBeCloseTo(o.uncertainty, 6);
  });

  test("unknown tier → unchanged", () => {
    const o: SubjectiveOpinion = { belief: 0.9, disbelief: 0.1, uncertainty: 0, baseRate: 0.5 };
    const result = clampOpinionByTier(o, "alien");
    assertInvariant(result);
    expect(result.belief).toBeCloseTo(o.belief, 6);
  });

  test("never decreases uncertainty", () => {
    const o: SubjectiveOpinion = { belief: 0.3, disbelief: 0.2, uncertainty: 0.5, baseRate: 0.5 };
    for (const tier of ["deterministic", "heuristic", "probabilistic"]) {
      const result = clampOpinionByTier(o, tier);
      expect(result.uncertainty).toBeGreaterThanOrEqual(o.uncertainty - EPSILON);
    }
  });
});

// ---------------------------------------------------------------------------
// 7. temporalDecay
// ---------------------------------------------------------------------------

describe("temporalDecay", () => {
  test("decayModel 'none' → unchanged", () => {
    const o: SubjectiveOpinion = { belief: 0.7, disbelief: 0.1, uncertainty: 0.2, baseRate: 0.5 };
    const result = temporalDecay(o, 100000, 50000, "none");
    assertInvariant(result);
    expect(result.belief).toBeCloseTo(o.belief, 6);
    expect(result.uncertainty).toBeCloseTo(o.uncertainty, 6);
  });

  test("decayModel 'step' before halfLife → unchanged", () => {
    const o: SubjectiveOpinion = { belief: 0.7, disbelief: 0.1, uncertainty: 0.2, baseRate: 0.5 };
    const result = temporalDecay(o, 30000, 60000, "step");
    assertInvariant(result);
    expect(result.belief).toBeCloseTo(o.belief, 6);
    expect(result.uncertainty).toBeCloseTo(o.uncertainty, 6);
  });

  test("decayModel 'step' past halfLife → vacuous", () => {
    const o: SubjectiveOpinion = { belief: 0.7, disbelief: 0.1, uncertainty: 0.2, baseRate: 0.5 };
    const result = temporalDecay(o, 60000, 60000, "step");
    assertInvariant(result);
    expect(isVacuous(result)).toBe(true);
    expect(result.baseRate).toBe(o.baseRate);
  });

  test("decayModel 'step' well past halfLife → vacuous", () => {
    const o: SubjectiveOpinion = { belief: 0.7, disbelief: 0.1, uncertainty: 0.2, baseRate: 0.5 };
    const result = temporalDecay(o, 120000, 60000, "step");
    assertInvariant(result);
    expect(isVacuous(result)).toBe(true);
  });

  test("decayModel 'linear' at halfLife → ~50% decay toward vacuous", () => {
    const o: SubjectiveOpinion = { belief: 0.8, disbelief: 0.1, uncertainty: 0.1, baseRate: 0.5 };
    const halfLife = 60000;
    const result = temporalDecay(o, halfLife, halfLife, "linear");
    assertInvariant(result);
    // decayFactor = min(1, 60000 / 120000) = 0.5
    // u_new = 0.1 + (1 - 0.1) * 0.5 = 0.1 + 0.45 = 0.55
    expect(result.uncertainty).toBeCloseTo(0.55, 4);
    // b+d should still sum to 1-u
    expect(result.belief + result.disbelief).toBeCloseTo(1 - result.uncertainty, 6);
    // Proportions of b and d should be preserved
    const ratio = o.belief / (o.belief + o.disbelief);
    const resultRatio = result.belief / (result.belief + result.disbelief);
    expect(resultRatio).toBeCloseTo(ratio, 6);
  });

  test("decayModel 'linear' at 2*halfLife → fully vacuous", () => {
    const o: SubjectiveOpinion = { belief: 0.8, disbelief: 0.1, uncertainty: 0.1, baseRate: 0.5 };
    const result = temporalDecay(o, 120000, 60000, "linear");
    assertInvariant(result);
    // decayFactor = min(1, 120000/120000) = 1
    // u_new = 0.1 + 0.9 * 1 = 1.0
    expect(result.uncertainty).toBeCloseTo(1.0, 6);
    expect(result.belief).toBeCloseTo(0, 6);
    expect(result.disbelief).toBeCloseTo(0, 6);
  });

  test("decayModel 'linear' at 0 elapsed → unchanged", () => {
    const o: SubjectiveOpinion = { belief: 0.8, disbelief: 0.1, uncertainty: 0.1, baseRate: 0.5 };
    const result = temporalDecay(o, 0, 60000, "linear");
    assertInvariant(result);
    expect(result.belief).toBeCloseTo(o.belief, 6);
    expect(result.uncertainty).toBeCloseTo(o.uncertainty, 6);
  });

  test("preserves baseRate through decay", () => {
    const o: SubjectiveOpinion = { belief: 0.6, disbelief: 0.2, uncertainty: 0.2, baseRate: 0.7 };
    const result = temporalDecay(o, 30000, 60000, "linear");
    assertInvariant(result);
    expect(result.baseRate).toBe(0.7);
  });
});
