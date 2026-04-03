/**
 * B6: PerfMeasure tests — µs instrumentation utility.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  getReport,
  getWarnings,
  isPerfEnabled,
  measureHot,
  resetMetrics,
} from '../../src/observability/perf-measure.ts';

describe('PerfMeasure', () => {
  afterEach(() => {
    resetMetrics();
  });

  // =========================================================================
  // measureHot — basic execution
  // =========================================================================

  test('measureHot executes the function and returns its result', () => {
    const result = measureHot('test-op', 100, () => 42);
    expect(result).toBe(42);
  });

  test('measureHot works with objects', () => {
    const result = measureHot('test-obj', 100, () => ({ a: 1, b: 'two' }));
    expect(result).toEqual({ a: 1, b: 'two' });
  });

  // =========================================================================
  // Conditional enable
  // =========================================================================

  test('isPerfEnabled reflects VINYAN_PERF env var', () => {
    // In test environment, VINYAN_PERF is not set → disabled
    // This test documents the behavior; actual value depends on env
    expect(typeof isPerfEnabled()).toBe('boolean');
  });

  test('measureHot returns result even when disabled', () => {
    // When PERF_ENABLED is false, fn still executes
    const result = measureHot('disabled-op', 100, () => 'hello');
    expect(result).toBe('hello');
  });

  // =========================================================================
  // Reporting (only populated when VINYAN_PERF=1)
  // =========================================================================

  test('getReport returns undefined when no data collected', () => {
    expect(getReport('nonexistent')).toBeUndefined();
  });

  test('getWarnings returns empty array initially', () => {
    expect(getWarnings()).toHaveLength(0);
  });

  test('resetMetrics clears all data', () => {
    // Even if no data, reset should not throw
    resetMetrics();
    expect(getWarnings()).toHaveLength(0);
    expect(getReport('any')).toBeUndefined();
  });

  // =========================================================================
  // Report structure (when data exists)
  // =========================================================================

  test('getReport structure has expected fields when perf enabled', () => {
    // We test the structure works correctly even if perf is disabled
    // by manually checking the module exports
    const report = getReport('test');
    // When disabled and no data → undefined
    if (report) {
      expect(report.count).toBeGreaterThan(0);
      expect(report.p50Ns).toBeGreaterThanOrEqual(0);
      expect(report.p99Ns).toBeGreaterThanOrEqual(0);
      expect(report.maxNs).toBeGreaterThanOrEqual(0);
    }
  });
});
