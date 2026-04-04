/**
 * D3 + D8: IntervalScore for CalibrationEngine
 * IS = (hi - lo) + (2/α)(lo - x)·𝟙(x < lo) + (2/α)(x - hi)·𝟙(x > hi)
 * α = 0.2 for 80% nominal coverage
 */
import { describe, expect, it } from 'bun:test';
import { CalibrationEngineImpl } from '@vinyan/orchestrator/calibration-engine.ts';
import type { PredictionDistribution } from '@vinyan/orchestrator/forward-predictor-types.ts';

const ALPHA = 0.2;

describe('CalibrationEngine — scoreInterval', () => {
  it('actual inside [lo, hi] → penalty = spread only', () => {
    const engine = new CalibrationEngineImpl();
    const pred: PredictionDistribution = { lo: 2, mid: 5, hi: 8 };
    const is = engine.scoreInterval(pred, 5);
    expect(is).toBe(8 - 2); // spread = 6, no undershoot/overshoot
  });

  it('actual below lo → additional undershoot penalty', () => {
    const engine = new CalibrationEngineImpl();
    const pred: PredictionDistribution = { lo: 3, mid: 5, hi: 7 };
    const actual = 1;
    const is = engine.scoreInterval(pred, actual);
    const expected = (7 - 3) + (2 / ALPHA) * (3 - 1);
    expect(is).toBeCloseTo(expected, 10);
  });

  it('actual above hi → additional overshoot penalty', () => {
    const engine = new CalibrationEngineImpl();
    const pred: PredictionDistribution = { lo: 3, mid: 5, hi: 7 };
    const actual = 10;
    const is = engine.scoreInterval(pred, actual);
    const expected = (7 - 3) + (2 / ALPHA) * (10 - 7);
    expect(is).toBeCloseTo(expected, 10);
  });

  it('exact match (lo=mid=hi=actual) → IS = 0', () => {
    const engine = new CalibrationEngineImpl();
    const pred: PredictionDistribution = { lo: 5, mid: 5, hi: 5 };
    const is = engine.scoreInterval(pred, 5);
    expect(is).toBe(0);
  });

  it('wide interval → larger spread penalty', () => {
    const engine = new CalibrationEngineImpl();
    const narrow: PredictionDistribution = { lo: 4, mid: 5, hi: 6 };
    const wide: PredictionDistribution = { lo: 1, mid: 5, hi: 9 };
    const isNarrow = engine.scoreInterval(narrow, 5);
    const isWide = engine.scoreInterval(wide, 5);
    expect(isWide).toBeGreaterThan(isNarrow);
    expect(isNarrow).toBe(2);
    expect(isWide).toBe(8);
  });

  it('actual at boundary lo → no undershoot penalty', () => {
    const engine = new CalibrationEngineImpl();
    const pred: PredictionDistribution = { lo: 3, mid: 5, hi: 7 };
    const is = engine.scoreInterval(pred, 3);
    expect(is).toBe(7 - 3); // spread only
  });

  it('actual at boundary hi → no overshoot penalty', () => {
    const engine = new CalibrationEngineImpl();
    const pred: PredictionDistribution = { lo: 3, mid: 5, hi: 7 };
    const is = engine.scoreInterval(pred, 7);
    expect(is).toBe(7 - 3); // spread only
  });

  it('returns IS value correctly (non-negative)', () => {
    const engine = new CalibrationEngineImpl();
    const pred: PredictionDistribution = { lo: 0, mid: 0.5, hi: 1 };
    // All cases should yield non-negative IS
    expect(engine.scoreInterval(pred, 0.5)).toBeGreaterThanOrEqual(0);
    expect(engine.scoreInterval(pred, -1)).toBeGreaterThanOrEqual(0);
    expect(engine.scoreInterval(pred, 2)).toBeGreaterThanOrEqual(0);
  });
});

describe('CalibrationEngine — interval coverage tracking', () => {
  it('8/10 inside → coverage ≈ 0.8', () => {
    const engine = new CalibrationEngineImpl();
    const pred: PredictionDistribution = { lo: 2, mid: 5, hi: 8 };

    // 8 inside
    for (let i = 0; i < 8; i++) {
      engine.scoreInterval(pred, 5, 'blast');
    }
    // 2 outside
    engine.scoreInterval(pred, 0, 'blast');
    engine.scoreInterval(pred, 10, 'blast');

    const summary = engine.getCalibrationSummary();
    expect(summary.coverageBlast).toBeCloseTo(0.8, 10);
  });

  it('all outside → coverage = 0', () => {
    const engine = new CalibrationEngineImpl();
    const pred: PredictionDistribution = { lo: 4, mid: 5, hi: 6 };
    engine.scoreInterval(pred, 0, 'blast');
    engine.scoreInterval(pred, 10, 'blast');
    engine.scoreInterval(pred, 100, 'blast');

    const summary = engine.getCalibrationSummary();
    expect(summary.coverageBlast).toBe(0);
  });

  it('all inside → coverage = 1', () => {
    const engine = new CalibrationEngineImpl();
    const pred: PredictionDistribution = { lo: 0, mid: 5, hi: 10 };
    for (let i = 0; i <= 10; i++) {
      engine.scoreInterval(pred, i, 'quality');
    }

    const summary = engine.getCalibrationSummary();
    expect(summary.coverageQuality).toBe(1);
  });

  it('separate blast and quality tracking', () => {
    const engine = new CalibrationEngineImpl();
    const pred: PredictionDistribution = { lo: 3, mid: 5, hi: 7 };

    // blast: 1/2 inside
    engine.scoreInterval(pred, 5, 'blast');
    engine.scoreInterval(pred, 0, 'blast');

    // quality: 2/2 inside
    engine.scoreInterval(pred, 4, 'quality');
    engine.scoreInterval(pred, 6, 'quality');

    const summary = engine.getCalibrationSummary();
    expect(summary.coverageBlast).toBeCloseTo(0.5, 10);
    expect(summary.coverageQuality).toBeCloseTo(1.0, 10);
  });
});

describe('CalibrationEngine — interval in summary', () => {
  it('empty state → interval fields absent', () => {
    const engine = new CalibrationEngineImpl();
    const summary = engine.getCalibrationSummary();
    expect(summary.intervalScoreBlast).toBeUndefined();
    expect(summary.intervalScoreQuality).toBeUndefined();
    expect(summary.coverageBlast).toBeUndefined();
    expect(summary.coverageQuality).toBeUndefined();
  });

  it('summary includes average interval scores', () => {
    const engine = new CalibrationEngineImpl();
    const pred: PredictionDistribution = { lo: 2, mid: 5, hi: 8 };

    // Two blast scores: inside=6, outside=6+(2/0.2)*(10-8)=6+20=26
    engine.scoreInterval(pred, 5, 'blast');
    engine.scoreInterval(pred, 10, 'blast');

    const summary = engine.getCalibrationSummary();
    expect(summary.intervalScoreBlast).toBeCloseTo((6 + 26) / 2, 10);
    expect(summary.intervalScoreQuality).toBeUndefined();
  });

  it('default kind is blast', () => {
    const engine = new CalibrationEngineImpl();
    const pred: PredictionDistribution = { lo: 2, mid: 5, hi: 8 };
    engine.scoreInterval(pred, 5); // no kind specified → defaults to 'blast'

    const summary = engine.getCalibrationSummary();
    expect(summary.intervalScoreBlast).toBe(6);
    expect(summary.coverageBlast).toBe(1);
    expect(summary.intervalScoreQuality).toBeUndefined();
  });
});
