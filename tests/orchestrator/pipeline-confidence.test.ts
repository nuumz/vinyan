import { describe, expect, test } from 'bun:test';
import {
  computePipelineConfidence,
  deriveConfidenceDecision,
  PIPELINE_THRESHOLDS,
  PIPELINE_WEIGHTS,
} from '../../src/orchestrator/pipeline-confidence.ts';

describe('computePipelineConfidence', () => {
  test('verification=1.0 and generation=1.0 → composite close to 1.0', () => {
    const pc = computePipelineConfidence({ verification: 1.0, generation: 1.0 });
    // Missing dims use 0.7; 0.7^(0.15+0.05+0.10+0.20) * 1^(0.10+0.40) ≈ 0.7^0.50 ≈ 0.837
    expect(pc.composite).toBeGreaterThan(0.80);
    expect(pc.composite).toBeLessThanOrEqual(1.0);
  });

  test('verification=0.0 → composite = 0 (verification dominates at 0.40)', () => {
    const pc = computePipelineConfidence({ verification: 0.0, generation: 1.0 });
    expect(pc.composite).toBe(0);
  });

  test('all dimensions = 1.0 → composite = 1.0', () => {
    const pc = computePipelineConfidence({
      prediction: 1.0,
      metaPrediction: 1.0,
      planning: 1.0,
      generation: 1.0,
      verification: 1.0,
      critic: 1.0,
    });
    expect(pc.composite).toBeCloseTo(1.0);
  });

  test('missing dims default to 0.7 (neutral)', () => {
    const full = computePipelineConfidence({
      prediction: 0.7,
      metaPrediction: 0.7,
      planning: 0.7,
      generation: 0.7,
      verification: 0.8,
      critic: 0.7,
    });
    const partial = computePipelineConfidence({ verification: 0.8 });
    expect(partial.composite).toBeCloseTo(full.composite, 9);
  });

  test('NaN input treated as 0.5 neutral', () => {
    const withNaN = computePipelineConfidence({ verification: Number.NaN, generation: 0.8 });
    const withNeutral = computePipelineConfidence({ verification: 0.5, generation: 0.8 });
    expect(withNaN.composite).toBeCloseTo(withNeutral.composite, 9);
  });

  test('formula string is present and non-empty', () => {
    const pc = computePipelineConfidence({ verification: 0.9 });
    expect(pc.formula).toBeTruthy();
    expect(pc.formula).toContain('composite');
  });

  test('dataAvailability reflects provided keys', () => {
    const pc = computePipelineConfidence({ prediction: 0.8, verification: 0.9 });
    expect(pc.dataAvailability.predictionAvailable).toBe(true);
    expect(pc.dataAvailability.planningAvailable).toBe(false);
    expect(pc.dataAvailability.criticAvailable).toBe(false);
  });

  test('dataAvailability: planning and critic provided', () => {
    const pc = computePipelineConfidence({ planning: 0.7, critic: 0.85 });
    expect(pc.dataAvailability.planningAvailable).toBe(true);
    expect(pc.dataAvailability.criticAvailable).toBe(true);
    expect(pc.dataAvailability.predictionAvailable).toBe(false);
  });

  test('weights sum to 1.0', () => {
    const total = Object.values(PIPELINE_WEIGHTS).reduce((a, b) => a + b, 0);
    expect(total).toBeCloseTo(1.0);
  });
});

describe('deriveConfidenceDecision', () => {
  test('0.75 → allow', () => {
    expect(deriveConfidenceDecision(0.75)).toBe('allow');
  });

  test('0.70 (boundary) → allow', () => {
    expect(deriveConfidenceDecision(PIPELINE_THRESHOLDS.ALLOW)).toBe('allow');
  });

  test('0.55 → re-verify', () => {
    expect(deriveConfidenceDecision(0.55)).toBe('re-verify');
  });

  test('0.50 (boundary) → re-verify', () => {
    expect(deriveConfidenceDecision(PIPELINE_THRESHOLDS.RE_VERIFY)).toBe('re-verify');
  });

  test('0.35 → escalate', () => {
    expect(deriveConfidenceDecision(0.35)).toBe('escalate');
  });

  test('0.30 (boundary) → escalate', () => {
    expect(deriveConfidenceDecision(PIPELINE_THRESHOLDS.ESCALATE)).toBe('escalate');
  });

  test('0.20 → refuse', () => {
    expect(deriveConfidenceDecision(0.20)).toBe('refuse');
  });

  test('0.0 → refuse', () => {
    expect(deriveConfidenceDecision(0)).toBe('refuse');
  });

  test('1.0 → allow', () => {
    expect(deriveConfidenceDecision(1.0)).toBe('allow');
  });
});
