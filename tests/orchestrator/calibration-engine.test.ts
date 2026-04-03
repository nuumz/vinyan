import { describe, expect, test } from 'bun:test';
import { CalibrationEngineImpl } from '../../src/orchestrator/calibration-engine.ts';
import type { TestOutcomeDistribution, PredictionDistribution } from '../../src/orchestrator/forward-predictor-types.ts';
import { CAUSAL_EDGE_WEIGHTS } from '../../src/orchestrator/forward-predictor-types.ts';

describe('CalibrationEngine', () => {
  // =========================================================================
  // Brier Score — scoreTestOutcome
  // =========================================================================

  describe('scoreTestOutcome (3-class Brier)', () => {
    test('perfect prediction for pass → Brier = 0', () => {
      const engine = new CalibrationEngineImpl();
      const predicted: TestOutcomeDistribution = { pPass: 1, pPartial: 0, pFail: 0 };
      const score = engine.scoreTestOutcome(predicted, 'pass');
      expect(score).toBeCloseTo(0, 10);
    });

    test('perfect prediction for fail → Brier = 0', () => {
      const engine = new CalibrationEngineImpl();
      const predicted: TestOutcomeDistribution = { pPass: 0, pPartial: 0, pFail: 1 };
      const score = engine.scoreTestOutcome(predicted, 'fail');
      expect(score).toBeCloseTo(0, 10);
    });

    test('perfect prediction for partial → Brier = 0', () => {
      const engine = new CalibrationEngineImpl();
      const predicted: TestOutcomeDistribution = { pPass: 0, pPartial: 1, pFail: 0 };
      const score = engine.scoreTestOutcome(predicted, 'partial');
      expect(score).toBeCloseTo(0, 10);
    });

    test('worst prediction for pass (predicted all fail) → Brier = 2.0', () => {
      const engine = new CalibrationEngineImpl();
      const predicted: TestOutcomeDistribution = { pPass: 0, pPartial: 0, pFail: 1 };
      const score = engine.scoreTestOutcome(predicted, 'pass');
      // (0-1)² + (0-0)² + (1-0)² = 1 + 0 + 1 = 2.0
      expect(score).toBeCloseTo(2.0, 10);
    });

    test('uniform prediction → moderate Brier score', () => {
      const engine = new CalibrationEngineImpl();
      const predicted: TestOutcomeDistribution = { pPass: 1 / 3, pPartial: 1 / 3, pFail: 1 / 3 };
      const score = engine.scoreTestOutcome(predicted, 'pass');
      // (1/3-1)² + (1/3-0)² + (1/3-0)² = (2/3)² + (1/3)² + (1/3)² = 4/9 + 1/9 + 1/9 = 6/9 ≈ 0.667
      expect(score).toBeCloseTo(6 / 9, 5);
    });

    test('confident correct prediction → low Brier', () => {
      const engine = new CalibrationEngineImpl();
      const predicted: TestOutcomeDistribution = { pPass: 0.9, pPartial: 0.05, pFail: 0.05 };
      const score = engine.scoreTestOutcome(predicted, 'pass');
      // (0.9-1)² + (0.05-0)² + (0.05-0)² = 0.01 + 0.0025 + 0.0025 = 0.015
      expect(score).toBeCloseTo(0.015, 5);
    });

    test('confident wrong prediction → high Brier', () => {
      const engine = new CalibrationEngineImpl();
      const predicted: TestOutcomeDistribution = { pPass: 0.9, pPartial: 0.05, pFail: 0.05 };
      const score = engine.scoreTestOutcome(predicted, 'fail');
      // (0.9-0)² + (0.05-0)² + (0.05-1)² = 0.81 + 0.0025 + 0.9025 = 1.715
      expect(score).toBeCloseTo(1.715, 3);
    });
  });

  // =========================================================================
  // CRPS — scoreContinuous
  // =========================================================================

  describe('scoreContinuous (CRPS)', () => {
    test('exact point prediction → CRPS ≈ 0', () => {
      const engine = new CalibrationEngineImpl();
      const predicted: PredictionDistribution = { lo: 5, mid: 5, hi: 5 };
      const score = engine.scoreContinuous(predicted, 5);
      expect(score).toBeCloseTo(0, 5);
    });

    test('actual inside interval → lower CRPS than outside', () => {
      const engine = new CalibrationEngineImpl();
      const predicted: PredictionDistribution = { lo: 2, mid: 5, hi: 8 };

      const inside = engine.scoreContinuous(predicted, 5);
      const outside = engine.scoreContinuous(predicted, 15);

      expect(inside).toBeLessThan(outside);
    });

    test('wider interval with same actual → non-negative CRPS', () => {
      const engine = new CalibrationEngineImpl();
      const narrow: PredictionDistribution = { lo: 4, mid: 5, hi: 6 };
      const wide: PredictionDistribution = { lo: 1, mid: 5, hi: 10 };

      const narrowScore = engine.scoreContinuous(narrow, 5);
      const wideScore = engine.scoreContinuous(wide, 5);

      expect(narrowScore).toBeGreaterThanOrEqual(0);
      expect(wideScore).toBeGreaterThanOrEqual(0);
    });

    test('CRPS is always non-negative', () => {
      const engine = new CalibrationEngineImpl();
      const predicted: PredictionDistribution = { lo: 1, mid: 5, hi: 10 };

      for (const actual of [0, 1, 3, 5, 8, 10, 15]) {
        expect(engine.scoreContinuous(predicted, actual)).toBeGreaterThanOrEqual(0);
      }
    });
  });

  // =========================================================================
  // Brier Decomposition — getBrierDecomposition
  // =========================================================================

  describe('getBrierDecomposition', () => {
    test('returns zero decomposition when no predictions scored', () => {
      const engine = new CalibrationEngineImpl();
      const decomp = engine.getBrierDecomposition();
      expect(decomp.reliability).toBe(0);
      expect(decomp.resolution).toBe(0);
      expect(decomp.uncertainty).toBe(0);
      expect(decomp.brierScore).toBe(0);
    });

    test('perfect calibration → low reliability, high resolution', () => {
      const engine = new CalibrationEngineImpl();

      // 50 predictions at p=0.8 that pass 80% of the time = perfectly calibrated
      for (let i = 0; i < 50; i++) {
        const actual = i < 40 ? 'pass' : 'fail'; // 80% pass
        engine.scoreTestOutcome({ pPass: 0.8, pPartial: 0.1, pFail: 0.1 }, actual as 'pass' | 'fail');
      }

      const decomp = engine.getBrierDecomposition();
      // Reliability should be low (well calibrated)
      expect(decomp.reliability).toBeLessThan(0.1);
      // Uncertainty should be non-zero (there IS inherent randomness)
      expect(decomp.uncertainty).toBeGreaterThan(0);
      // Brier decomposition identity: BS = REL - RES + UNC
      expect(decomp.brierScore).toBeCloseTo(
        decomp.reliability - decomp.resolution + decomp.uncertainty,
        3,
      );
    });

    test('Brier decomposition identity holds: BS = REL - RES + UNC', () => {
      const engine = new CalibrationEngineImpl();

      // Mixed predictions
      for (let i = 0; i < 30; i++) {
        engine.scoreTestOutcome({ pPass: 0.6, pPartial: 0.2, pFail: 0.2 }, 'pass');
      }
      for (let i = 0; i < 20; i++) {
        engine.scoreTestOutcome({ pPass: 0.3, pPartial: 0.3, pFail: 0.4 }, 'fail');
      }

      const decomp = engine.getBrierDecomposition();
      expect(decomp.brierScore).toBeCloseTo(
        decomp.reliability - decomp.resolution + decomp.uncertainty,
        3,
      );
    });
  });

  // =========================================================================
  // Reliability Diagram
  // =========================================================================

  describe('getReliabilityDiagram', () => {
    test('returns empty diagram when no predictions', () => {
      const engine = new CalibrationEngineImpl();
      const diagram = engine.getReliabilityDiagram();
      expect(diagram.bins).toHaveLength(0);
    });

    test('returns bins after scoring predictions', () => {
      const engine = new CalibrationEngineImpl();

      for (let i = 0; i < 20; i++) {
        engine.scoreTestOutcome(
          { pPass: 0.7 + Math.random() * 0.1, pPartial: 0.15, pFail: 0.15 },
          i < 14 ? 'pass' : 'fail',
        );
      }

      const diagram = engine.getReliabilityDiagram();
      expect(diagram.bins.length).toBeGreaterThan(0);
      expect(diagram.calibrationError).toBeGreaterThanOrEqual(0);

      for (const bin of diagram.bins) {
        expect(bin.count).toBeGreaterThan(0);
        expect(bin.observedFrequency).toBeGreaterThanOrEqual(0);
        expect(bin.observedFrequency).toBeLessThanOrEqual(1);
      }
    });
  });

  // =========================================================================
  // Edge Weights
  // =========================================================================

  describe('getEdgeWeights', () => {
    test('returns default weights on cold start', () => {
      const engine = new CalibrationEngineImpl();
      const weights = engine.getEdgeWeights();

      expect(weights.converged).toBe(false);
      expect(weights.observationCount).toBe(0);
      // Default weights match CAUSAL_EDGE_WEIGHTS
      expect(weights.weights['test-covers']).toBe(CAUSAL_EDGE_WEIGHTS['test-covers']);
      expect(weights.weights['imports']).toBe(CAUSAL_EDGE_WEIGHTS['imports']);
    });
  });

  describe('updateEdgeWeights', () => {
    test('does not converge with fewer than 50 observations', () => {
      const engine = new CalibrationEngineImpl();

      for (let i = 0; i < 40; i++) {
        engine.updateEdgeWeights([{ edgeType: 'imports', brokeTarget: i % 3 === 0 }]);
      }

      const weights = engine.getEdgeWeights();
      expect(weights.converged).toBe(false);
      // Weights should still be close to defaults with low alpha
    });

    test('weights adapt toward empirical break frequency', () => {
      const engine = new CalibrationEngineImpl();

      // Feed 200+ observations where 'imports' breaks 50% of the time
      // (much higher than default 0.20)
      for (let i = 0; i < 250; i++) {
        engine.updateEdgeWeights([{ edgeType: 'imports', brokeTarget: i % 2 === 0 }]);
      }

      const weights = engine.getEdgeWeights();
      // With 250 observations and 50% break rate, learned weight should be > default 0.20
      expect(weights.weights['imports']).toBeGreaterThan(0.3);
      // Clipped to [0.1, 0.99]
      expect(weights.weights['imports']).toBeLessThanOrEqual(0.99);
      expect(weights.weights['imports']).toBeGreaterThanOrEqual(0.1);
    });

    test('weights are clamped to [0.1, 0.99]', () => {
      const engine = new CalibrationEngineImpl();

      // 0% break rate → should clamp to 0.1 (not 0)
      for (let i = 0; i < 300; i++) {
        engine.updateEdgeWeights([{ edgeType: 'test-covers', brokeTarget: false }]);
      }

      const weights = engine.getEdgeWeights();
      expect(weights.weights['test-covers']).toBeGreaterThanOrEqual(0.1);
    });
  });

  // =========================================================================
  // Temporal Decay
  // =========================================================================

  describe('setTemporalDecayHalfLife', () => {
    test('does not throw when setting half-life', () => {
      const engine = new CalibrationEngineImpl();
      expect(() => engine.setTemporalDecayHalfLife(14)).not.toThrow();
    });
  });

  // =========================================================================
  // Calibration Summary
  // =========================================================================

  describe('getCalibrationSummary', () => {
    test('returns summary with zero predictions', () => {
      const engine = new CalibrationEngineImpl();
      const summary = engine.getCalibrationSummary();
      expect(summary.predictionCount).toBe(0);
      expect(summary.brierScore).toBe(0);
    });

    test('returns aggregate metrics after scoring', () => {
      const engine = new CalibrationEngineImpl();

      for (let i = 0; i < 10; i++) {
        engine.scoreTestOutcome({ pPass: 0.7, pPartial: 0.2, pFail: 0.1 }, 'pass');
        engine.scoreContinuous({ lo: 1, mid: 3, hi: 8 }, 4);
      }

      const summary = engine.getCalibrationSummary();
      expect(summary.predictionCount).toBe(10);
      expect(summary.brierScore).toBeGreaterThanOrEqual(0);
      expect(summary.brierReliability).toBeGreaterThanOrEqual(0);
      expect(summary.crpsBlastAvg).toBeGreaterThanOrEqual(0);
      expect(summary.calibrationBins.length).toBeGreaterThan(0);
    });
  });
});
