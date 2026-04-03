import { describe, expect, test } from 'bun:test';
import { OutcomePredictorImpl } from '../../src/orchestrator/outcome-predictor.ts';
import type { SelfModelPrediction } from '../../src/orchestrator/types.ts';
import type { FileOutcomeStat, PredictionDistribution } from '../../src/orchestrator/forward-predictor-types.ts';

function makeHeuristic(overrides: Partial<SelfModelPrediction> = {}): SelfModelPrediction {
  return {
    taskId: 'task-1',
    timestamp: Date.now(),
    expectedTestResults: 'pass',
    expectedBlastRadius: 3,
    expectedDuration: 5000,
    expectedQualityScore: 75,
    uncertainAreas: [],
    confidence: 0.5,
    metaConfidence: 0.3,
    basis: 'static-heuristic',
    calibrationDataPoints: 0,
    ...overrides,
  };
}

function makeFileStat(filePath: string, successCount: number, failCount: number, partialCount = 0): FileOutcomeStat {
  return {
    filePath,
    successCount,
    failCount,
    partialCount,
    samples: successCount + failCount + partialCount,
    avgQuality: 70,
  };
}

const zeroPctile: PredictionDistribution = { lo: 0, mid: 0, hi: 0 };
const defaultPctile: PredictionDistribution = { lo: 1, mid: 3, hi: 8 };

describe('OutcomePredictor', () => {
  const predictor = new OutcomePredictorImpl();

  // =========================================================================
  // Bayesian blend alpha weight verification
  // =========================================================================

  describe('Bayesian blend alpha decay', () => {
    test('n=0 files → pure prior (alpha ≈ 1.0)', () => {
      const result = predictor.enhance(makeHeuristic(), [], defaultPctile, defaultPctile);

      // With 0 files, should return the prior distribution
      // Prior for 'pass' = { pPass: 0.7, pPartial: 0.2, pFail: 0.1 }
      expect(result.testOutcome.pPass).toBeCloseTo(0.7, 1);
      expect(result.testOutcome.pPartial).toBeCloseTo(0.2, 1);
      expect(result.testOutcome.pFail).toBeCloseTo(0.1, 1);
    });

    test('n=3 files → mostly prior (alpha ≈ 0.94)', () => {
      // 3 files, all with 100% success
      const fileStats = [
        makeFileStat('a.ts', 10, 0),
        makeFileStat('b.ts', 10, 0),
        makeFileStat('c.ts', 10, 0),
      ];

      const result = predictor.enhance(makeHeuristic(), fileStats, defaultPctile, defaultPctile);

      // alpha ≈ exp(-3/50) ≈ 0.942
      // blendedPPass ≈ 0.942 * 0.7 + 0.058 * 1.0 ≈ 0.718
      expect(result.testOutcome.pPass).toBeGreaterThan(0.7);
      expect(result.testOutcome.pPass).toBeLessThan(0.8);
    });

    test('n=35 files → balanced blend (alpha ≈ 0.50)', () => {
      // 35 files, all with 90% success
      const fileStats = Array.from({ length: 35 }, (_, i) =>
        makeFileStat(`file-${i}.ts`, 9, 1),
      );

      const result = predictor.enhance(makeHeuristic(), fileStats, defaultPctile, defaultPctile);

      // alpha ≈ exp(-35/50) ≈ 0.497
      // blendedPPass ≈ 0.497 * 0.7 + 0.503 * 0.9 ≈ 0.801
      expect(result.testOutcome.pPass).toBeGreaterThan(0.75);
      expect(result.testOutcome.pPass).toBeLessThan(0.85);
    });

    test('n=100 files → mostly evidence (alpha ≈ 0.14)', () => {
      // 100 files, all with 60% success
      const fileStats = Array.from({ length: 100 }, (_, i) =>
        makeFileStat(`file-${i}.ts`, 6, 4),
      );

      const result = predictor.enhance(makeHeuristic(), fileStats, defaultPctile, defaultPctile);

      // alpha ≈ exp(-100/50) ≈ 0.135
      // blendedPPass ≈ 0.135 * 0.7 + 0.865 * 0.6 ≈ 0.614
      expect(result.testOutcome.pPass).toBeGreaterThan(0.58);
      expect(result.testOutcome.pPass).toBeLessThan(0.66);
    });
  });

  // =========================================================================
  // Distribution normalization
  // =========================================================================

  describe('distribution normalization', () => {
    test('pPass + pPartial + pFail = 1.0 for all inputs', () => {
      // Various heuristic expectations
      for (const expected of ['pass', 'fail', 'partial'] as const) {
        const result = predictor.enhance(
          makeHeuristic({ expectedTestResults: expected }),
          [],
          defaultPctile,
          defaultPctile,
        );

        const sum = result.testOutcome.pPass + result.testOutcome.pPartial + result.testOutcome.pFail;
        expect(sum).toBeCloseTo(1.0, 5);
      }
    });

    test('no negative probabilities even with extreme file stats', () => {
      // Files with 0% success → extreme pull toward fail
      const fileStats = Array.from({ length: 50 }, (_, i) =>
        makeFileStat(`file-${i}.ts`, 0, 10),
      );

      const result = predictor.enhance(makeHeuristic(), fileStats, defaultPctile, defaultPctile);

      expect(result.testOutcome.pPass).toBeGreaterThanOrEqual(0);
      expect(result.testOutcome.pPartial).toBeGreaterThanOrEqual(0);
      expect(result.testOutcome.pFail).toBeGreaterThanOrEqual(0);

      const sum = result.testOutcome.pPass + result.testOutcome.pPartial + result.testOutcome.pFail;
      expect(sum).toBeCloseTo(1.0, 5);
    });

    test('normalization handles all-pass file evidence', () => {
      const fileStats = Array.from({ length: 50 }, (_, i) =>
        makeFileStat(`file-${i}.ts`, 10, 0),
      );

      const result = predictor.enhance(
        makeHeuristic({ expectedTestResults: 'fail' }),
        fileStats,
        defaultPctile,
        defaultPctile,
      );

      // Even with heuristic = 'fail', strong evidence of pass should shift distribution
      expect(result.testOutcome.pPass).toBeGreaterThan(0.3);
      expect(result.testOutcome.pPass + result.testOutcome.pPartial + result.testOutcome.pFail).toBeCloseTo(1.0, 5);
    });
  });

  // =========================================================================
  // Prior computation from heuristic expectation
  // =========================================================================

  describe('prior from heuristic', () => {
    test('expected=pass → high pPass prior', () => {
      const result = predictor.enhance(makeHeuristic({ expectedTestResults: 'pass' }), [], zeroPctile, zeroPctile);
      expect(result.testOutcome.pPass).toBeGreaterThan(0.5);
    });

    test('expected=fail → low pPass prior', () => {
      const result = predictor.enhance(makeHeuristic({ expectedTestResults: 'fail' }), [], zeroPctile, zeroPctile);
      expect(result.testOutcome.pPass).toBeLessThan(0.3);
    });

    test('expected=partial → moderate pPass prior', () => {
      const result = predictor.enhance(makeHeuristic({ expectedTestResults: 'partial' }), [], zeroPctile, zeroPctile);
      expect(result.testOutcome.pPass).toBeGreaterThan(0.2);
      expect(result.testOutcome.pPass).toBeLessThan(0.6);
    });
  });

  // =========================================================================
  // Confidence
  // =========================================================================

  describe('confidence output', () => {
    test('confidence increases with file evidence count', () => {
      const result0 = predictor.enhance(makeHeuristic(), [], defaultPctile, defaultPctile);
      const result10 = predictor.enhance(
        makeHeuristic(),
        Array.from({ length: 10 }, (_, i) => makeFileStat(`f-${i}.ts`, 5, 5)),
        defaultPctile,
        defaultPctile,
      );

      expect(result10.confidence).toBeGreaterThan(result0.confidence);
    });

    test('confidence is at least 0.4', () => {
      const result = predictor.enhance(makeHeuristic(), [], defaultPctile, defaultPctile);
      expect(result.confidence).toBeGreaterThanOrEqual(0.4);
    });

    test('confidence maxes at 0.7', () => {
      const result = predictor.enhance(
        makeHeuristic(),
        Array.from({ length: 200 }, (_, i) => makeFileStat(`f-${i}.ts`, 5, 5)),
        defaultPctile,
        defaultPctile,
      );
      expect(result.confidence).toBeLessThanOrEqual(0.7);
    });
  });

  // =========================================================================
  // Passthrough of percentiles
  // =========================================================================

  describe('percentile passthrough', () => {
    test('blast radius percentiles are passed through from input', () => {
      const blast: PredictionDistribution = { lo: 2, mid: 5, hi: 12 };
      const result = predictor.enhance(makeHeuristic(), [], blast, defaultPctile);
      expect(result.blastRadius).toEqual(blast);
    });

    test('quality percentiles are passed through from input', () => {
      const quality: PredictionDistribution = { lo: 50, mid: 70, hi: 95 };
      const result = predictor.enhance(makeHeuristic(), [], defaultPctile, quality);
      expect(result.qualityScore).toEqual(quality);
    });
  });

  // =========================================================================
  // Edge: files with 0 samples
  // =========================================================================

  describe('edge cases', () => {
    test('files with 0 samples are filtered out', () => {
      const fileStats = [
        makeFileStat('a.ts', 0, 0, 0), // samples=0
        makeFileStat('b.ts', 8, 2),     // samples=10
      ];
      // Should not NaN or divide by zero
      const result = predictor.enhance(makeHeuristic(), fileStats, defaultPctile, defaultPctile);
      expect(Number.isNaN(result.testOutcome.pPass)).toBe(false);
      expect(Number.isNaN(result.testOutcome.pPartial)).toBe(false);
    });
  });
});
