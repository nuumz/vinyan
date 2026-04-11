import { describe, expect, test } from 'bun:test';
import { PredictionTierSelectorImpl } from '../../src/gate/prediction-tier-selector.ts';

describe('PredictionTierSelector', () => {
  const selector = new PredictionTierSelectorImpl();

  // --- Heuristic tier (default/cold-start) ---

  test('returns heuristic when 0 traces', () => {
    expect(selector.select(0, 0, false)).toBe('heuristic');
  });

  test('returns heuristic when traces below statistical gate (99)', () => {
    expect(selector.select(99, 0, false)).toBe('heuristic');
  });

  test('returns heuristic when traces below gate even with many edges', () => {
    expect(selector.select(50, 200, false)).toBe('heuristic');
  });

  // --- Statistical tier ---

  test('returns statistical when traces >= 100 and 0 edges', () => {
    expect(selector.select(100, 0, false)).toBe('statistical');
  });

  test('returns statistical when traces >= 100 and edges < 50', () => {
    expect(selector.select(100, 49, false)).toBe('statistical');
  });

  test('returns statistical when traces >= 100 and edges >= 50 but miscalibrated', () => {
    expect(selector.select(100, 50, true)).toBe('statistical');
  });

  test('returns statistical with large trace count and insufficient edges', () => {
    expect(selector.select(10000, 10, false)).toBe('statistical');
  });

  // --- Causal tier ---

  test('returns causal when traces >= 100, edges >= 50, no miscalibration', () => {
    expect(selector.select(100, 50, false)).toBe('causal');
  });

  test('returns causal with abundant data', () => {
    expect(selector.select(5000, 500, false)).toBe('causal');
  });

  // --- Miscalibration degrades from causal to statistical ---

  test('miscalibration flag degrades causal to statistical', () => {
    // Without flag → causal
    expect(selector.select(200, 100, false)).toBe('causal');
    // With flag → statistical
    expect(selector.select(200, 100, true)).toBe('statistical');
  });

  test('miscalibration does not affect heuristic tier', () => {
    // Below statistical gate — remains heuristic regardless
    expect(selector.select(50, 0, true)).toBe('heuristic');
  });

  // --- Custom configuration ---

  test('respects custom thresholds', () => {
    const custom = new PredictionTierSelectorImpl({
      minTracesStatistical: 50,
      minTracesCausal: 50,
      minEdgesCausal: 20,
    });

    expect(custom.select(49, 100, false)).toBe('heuristic');
    expect(custom.select(50, 19, false)).toBe('statistical');
    expect(custom.select(50, 20, false)).toBe('causal');
  });

  // --- Boundary precision ---

  test('exact boundary: 100 traces is inclusive for statistical', () => {
    expect(selector.select(100, 0, false)).toBe('statistical');
  });

  test('exact boundary: 50 edges is inclusive for causal', () => {
    expect(selector.select(100, 50, false)).toBe('causal');
  });
});
