/**
 * Prediction-window trigger tests (W4 SK4).
 *
 * The trigger is A7's heart: qualify ONLY on sustained composite-error
 * reduction, not on success-rate noise. Every test here nails one axis
 * (window fill, reduction magnitude, success fraction, Wilson LB).
 */
import { describe, expect, test } from 'bun:test';
import {
  buildWindowState,
  DEFAULT_WINDOW_POLICY,
  type PredictionErrorSample,
  type WindowPolicy,
} from '../../../src/skills/autonomous/index.ts';

/** Build a sample stream whose prior half has higher error than the recent half. */
function dropSamples(
  signature: string,
  priorErr: number,
  recentErr: number,
  outcome: PredictionErrorSample['outcome'] = 'success',
  count = 20,
): PredictionErrorSample[] {
  const half = count / 2;
  const result: PredictionErrorSample[] = [];
  for (let i = 0; i < count; i++) {
    result.push({
      taskId: `${signature}-${i}`,
      taskSignature: signature,
      compositeError: i < half ? priorErr : recentErr,
      outcome,
      ts: 1_000_000 + i * 1000,
    });
  }
  return result;
}

describe('buildWindowState qualification', () => {
  test('insufficient samples (< windowSize) → qualifies: false', () => {
    const samples = dropSamples('sig', 0.6, 0.2, 'success', 10); // windowSize default 15
    const state = buildWindowState('sig', samples);
    expect(state.qualifies).toBe(false);
    expect(state.samples.length).toBe(10);
  });

  test('win streak with flat error → qualifies: false (A7 anchor)', () => {
    // All successes, all low error, no drop between halves.
    const flat = dropSamples('sig', 0.1, 0.1, 'success', 20);
    const state = buildWindowState('sig', flat);
    expect(state.successFraction).toBe(1);
    expect(state.reductionDelta).toBe(0);
    expect(state.qualifies).toBe(false);
  });

  test('below-threshold reduction delta → qualifies: false', () => {
    // 0.05 drop, under 0.15 default threshold.
    const samples = dropSamples('sig', 0.2, 0.15, 'success', 20);
    const state = buildWindowState('sig', samples);
    expect(state.reductionDelta).toBeCloseTo(0.05, 5);
    expect(state.qualifies).toBe(false);
  });

  test('all thresholds pass → qualifies: true', () => {
    const samples = dropSamples('sig', 0.6, 0.2, 'success', 20);
    const state = buildWindowState('sig', samples);
    expect(state.meanPriorError).toBeCloseTo(0.6, 5);
    expect(state.meanRecentError).toBeCloseTo(0.2, 5);
    expect(state.reductionDelta).toBeCloseTo(0.4, 5);
    expect(state.successFraction).toBe(1);
    expect(state.wilsonLB).toBeGreaterThan(0.6);
    expect(state.qualifies).toBe(true);
  });

  test('Wilson LB below threshold (few successes, small N) → qualifies: false', () => {
    // Construct exactly `windowSize` samples with 80% success fraction but
    // Wilson LB below 0.6 (only achievable with small N + not-quite-perfect
    // successes). 15 samples, 12 successes — p=0.8, LB ≈ 0.546.
    const signature = 'sig';
    const samples: PredictionErrorSample[] = [];
    for (let i = 0; i < 15; i++) {
      samples.push({
        taskId: `${signature}-${i}`,
        taskSignature: signature,
        compositeError: i < 5 ? 0.6 : 0.1,
        outcome: i % 5 === 0 ? 'failure' : 'success', // 3 failures in 15 → 12/15 = 0.8
        ts: 1_000_000 + i * 1000,
      });
    }
    const state = buildWindowState(signature, samples);
    expect(state.successFraction).toBeCloseTo(12 / 15, 5);
    // Default policy: splitHalf=10, so need 20 samples to compute reductionDelta.
    // Here we have 15 — reductionDelta stays at 0, forcing qualifies=false.
    expect(state.reductionDelta).toBe(0);
    expect(state.qualifies).toBe(false);
  });

  test('policy override (minReductionDelta: 0.05) flips qualification on a small drop', () => {
    const samples = dropSamples('sig', 0.2, 0.15, 'success', 20);
    const baseline = buildWindowState('sig', samples);
    expect(baseline.qualifies).toBe(false);

    const relaxed: WindowPolicy = { ...DEFAULT_WINDOW_POLICY, minReductionDelta: 0.05 };
    const bumped = buildWindowState('sig', samples, relaxed);
    expect(bumped.qualifies).toBe(true);
  });

  test('zero samples → degenerate state with qualifies: false', () => {
    const state = buildWindowState('empty', []);
    expect(state.samples.length).toBe(0);
    expect(state.meanRecentError).toBe(0);
    expect(state.meanPriorError).toBe(0);
    expect(state.qualifies).toBe(false);
    expect(state.wilsonLB).toBe(0);
  });

  test('policy override — relaxed Wilson LB flips qualification on otherwise-good evidence', () => {
    // 12/15 = 0.8 success fraction on the default 15-sample tail; Wilson LB
    // is ≈ 0.548 which blocks on the default 0.6 floor. Relax to 0.5 and
    // the same samples now qualify.
    const signature = 'sig';
    const samples: PredictionErrorSample[] = [];
    for (let i = 0; i < 20; i++) {
      samples.push({
        taskId: `${signature}-${i}`,
        taskSignature: signature,
        compositeError: i < 10 ? 0.8 : 0.1,
        outcome: i % 5 === 0 ? 'failure' : 'success', // 4 failures / 20 = 0.8
        ts: 1_000_000 + i * 1000,
      });
    }
    const defaultState = buildWindowState(signature, samples);
    expect(defaultState.wilsonLB).toBeLessThan(0.6);
    expect(defaultState.qualifies).toBe(false); // Wilson LB blocks

    const relaxed: WindowPolicy = { ...DEFAULT_WINDOW_POLICY, minWilsonLB: 0.5 };
    const relaxedState = buildWindowState(signature, samples, relaxed);
    expect(relaxedState.qualifies).toBe(true);
  });

  test('samples are sorted by timestamp even when caller passes unordered input', () => {
    const base = dropSamples('sig', 0.6, 0.2, 'success', 20);
    // Shuffle deterministically.
    const shuffled = [base[5]!, base[1]!, base[19]!, ...base.slice(0, 19).filter((_, i) => i !== 5 && i !== 1)];
    const state = buildWindowState('sig', shuffled);
    // Post-sort the last sample should still be the original last sample.
    expect(state.samples[state.samples.length - 1]!.taskId).toBe('sig-19');
  });

  test('qualifies.reductionDelta reflects exact mean difference', () => {
    const samples = dropSamples('sig', 0.5, 0.1, 'success', 20);
    const state = buildWindowState('sig', samples);
    expect(state.reductionDelta).toBeCloseTo(0.4, 5);
  });

  test('recent regression (recent > prior) produces negative delta and blocks qualification', () => {
    const samples = dropSamples('sig', 0.1, 0.5, 'success', 20);
    const state = buildWindowState('sig', samples);
    expect(state.reductionDelta).toBeCloseTo(-0.4, 5);
    expect(state.qualifies).toBe(false);
  });
});
