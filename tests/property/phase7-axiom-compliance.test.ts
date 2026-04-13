/**
 * Phase 7 — A1-A4 axiom compliance property-based tests.
 *
 * Generative checks of the four ECP axioms across the operations Phase 7
 * relies on for calibration:
 *
 *   A1 (Epistemic Coherence):    b + d + u ≈ 1, all components in [0, 1].
 *   A2 (First-Class Uncertainty): u ≥ 0 — `fromScalar` never fabricates
 *                                 certainty when handed a confidence
 *                                 with an explicit defaultUncertainty.
 *   A3 (Deterministic Governance): identical inputs produce identical
 *                                  outputs across runs and across
 *                                  argument permutations where the
 *                                  operation is commutative.
 *   A4 (Risk-Aware Routing):     projected probabilities stay in [0, 1].
 *
 * Source of truth: docs/design/ecp-v2-system-design.md §12 (Compliance
 * test suite for A1-A4 evidential soundness).
 */
import { describe, expect, test } from 'bun:test';
import * as fc from 'fast-check';
import {
  cumulativeFusion,
  fromScalar,
  isValid,
  projectedProbability,
  SL_EPSILON,
  type SubjectiveOpinion,
} from '../../src/core/subjective-opinion.ts';
import { detectDrift } from '../../src/orchestrator/phase7/drift-detector.ts';
import { OracleEMACalibrator } from '../../src/orchestrator/phase7/oracle-ema-calibrator.ts';
import type { ExecutionTrace, SelfModelPrediction } from '../../src/orchestrator/types.ts';

// ── Generators ──────────────────────────────────────────────────────

const probArb = fc.float({ min: 0, max: 1, noNaN: true });
const baseRateArb = fc.float({ min: Math.fround(0.01), max: Math.fround(0.99), noNaN: true });

/** Generate a structurally valid opinion (b+d+u ≈ 1). */
const opinionArb: fc.Arbitrary<SubjectiveOpinion> = fc
  .tuple(probArb, probArb, baseRateArb)
  .map(([rawB, rawD, baseRate]) => {
    // Project (rawB, rawD, 1) into the simplex by normalizing.
    const sum = rawB + rawD + 1;
    return {
      belief: rawB / sum,
      disbelief: rawD / sum,
      uncertainty: 1 / sum,
      baseRate,
    };
  });

// ── A1: Epistemic coherence (closed under fusion + scalar conversion) ──

describe('A1 — Epistemic coherence', () => {
  test('fromScalar produces a valid opinion for any (confidence, uncertainty) pair', () => {
    fc.assert(
      fc.property(
        probArb,
        fc.float({ min: 0, max: 1, noNaN: true }),
        baseRateArb,
        (confidence, defaultU, baseRate) => {
          const o = fromScalar(confidence, baseRate, defaultU);
          expect(isValid(o)).toBe(true);
          // b + d + u = 1 (within SL_EPSILON), all components in [0, 1].
          expect(Math.abs(o.belief + o.disbelief + o.uncertainty - 1)).toBeLessThan(SL_EPSILON);
          expect(o.belief).toBeGreaterThanOrEqual(0);
          expect(o.disbelief).toBeGreaterThanOrEqual(0);
          expect(o.uncertainty).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 200 },
    );
  });

  test('cumulative fusion is closed in the simplex (output is still a valid opinion)', () => {
    fc.assert(
      fc.property(opinionArb, opinionArb, (a, b) => {
        const fused = cumulativeFusion(a, b);
        expect(isValid(fused)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });
});

// ── A2: First-class uncertainty (no fabricated certainty) ──

describe('A2 — First-class uncertainty', () => {
  test('fromScalar with defaultUncertainty > 0 always preserves at least that much uncertainty', () => {
    fc.assert(
      fc.property(probArb, fc.float({ min: Math.fround(0.01), max: Math.fround(0.99), noNaN: true }), (confidence, defaultU) => {
        const o = fromScalar(confidence, 0.5, defaultU);
        // Uncertainty must NEVER drop below the requested floor — that
        // would mean fromScalar fabricated certainty out of thin air.
        expect(o.uncertainty).toBeGreaterThanOrEqual(defaultU - SL_EPSILON);
      }),
      { numRuns: 200 },
    );
  });
});

// ── A3: Deterministic governance ──

describe('A3 — Deterministic governance', () => {
  test('fromScalar is a pure function — same inputs → same outputs across runs', () => {
    fc.assert(
      fc.property(probArb, baseRateArb, fc.float({ min: 0, max: 1, noNaN: true }), (c, br, u) => {
        const o1 = fromScalar(c, br, u);
        const o2 = fromScalar(c, br, u);
        expect(o1).toEqual(o2);
      }),
      { numRuns: 200 },
    );
  });

  test('OracleEMACalibrator is deterministic — same observation sequence → same final state', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.constantFrom('ast', 'type', 'dep', 'lint'),
            fc.boolean(),
            fc.boolean(),
          ),
          { minLength: 1, maxLength: 50 },
        ),
        (observations) => {
          const calA = new OracleEMACalibrator();
          const calB = new OracleEMACalibrator();
          for (const [name, verified, succeeded] of observations) {
            calA.record({ oracleName: name, verified, taskSucceeded: succeeded });
            calB.record({ oracleName: name, verified, taskSucceeded: succeeded });
          }
          expect(calA.snapshot()).toEqual(calB.snapshot());
        },
      ),
      { numRuns: 100 },
    );
  });

  test('detectDrift is a pure function over (prediction, trace)', () => {
    const prediction: SelfModelPrediction = {
      taskId: 't',
      timestamp: 0,
      expectedTestResults: 'pass',
      expectedBlastRadius: 4,
      expectedDuration: 10000,
      expectedQualityScore: 0.7,
      uncertainAreas: [],
      confidence: 0.7,
      metaConfidence: 0.5,
      basis: 'hybrid',
      calibrationDataPoints: 50,
    };
    const trace: ExecutionTrace = {
      id: 'trace-t',
      taskId: 't',
      timestamp: 0,
      routingLevel: 2,
      approach: 'direct-edit',
      oracleVerdicts: { ast: true },
      modelUsed: 'mock',
      tokensConsumed: 1000,
      durationMs: 11000,
      outcome: 'success',
      affectedFiles: ['a.ts'],
    };
    const r1 = detectDrift(prediction, trace);
    const r2 = detectDrift(prediction, trace);
    expect(r1).toEqual(r2);
  });
});

// ── A4: Risk-aware routing (projected probabilities stay in [0,1]) ──

describe('A4 — Risk-aware routing', () => {
  test('projected probability of any valid opinion is always in [0, 1]', () => {
    fc.assert(
      fc.property(opinionArb, (o) => {
        const p = projectedProbability(o);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
      }),
      { numRuns: 200 },
    );
  });

  test('projected probability of a fused opinion is also in [0, 1]', () => {
    fc.assert(
      fc.property(opinionArb, opinionArb, (a, b) => {
        const fused = cumulativeFusion(a, b);
        const p = projectedProbability(fused);
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThanOrEqual(1);
      }),
      { numRuns: 200 },
    );
  });
});
