import { describe, expect, test } from 'bun:test';
import { OracleEMACalibrator, ORACLE_EMA_WARM_THRESHOLD } from '../../../src/orchestrator/monitoring/oracle-ema-calibrator.ts';

describe('getWeightedConfidence (Wave C)', () => {
  test('cold oracle (0 observations) returns raw confidence', () => {
    const cal = new OracleEMACalibrator();
    expect(cal.getWeightedConfidence('lint', 0.8)).toBe(0.8);
  });

  test('warm oracle with high accuracy returns raw confidence', () => {
    const cal = new OracleEMACalibrator();
    // Record 20 agreeing observations → accuracy near 0.9
    for (let i = 0; i < 20; i++) {
      cal.record({ oracleName: 'lint', verified: true, taskSucceeded: true });
    }
    const result = cal.getWeightedConfidence('lint', 0.8);
    expect(result).toBe(0.8); // accuracy >> 0.5 → no attenuation
  });

  test('warm oracle with ~30% accuracy attenuates confidence', () => {
    const cal = new OracleEMACalibrator();
    // Record mixed observations: ~30% agreement rate
    // 6 agree, 14 disagree
    for (let i = 0; i < 6; i++) {
      cal.record({ oracleName: 'lint', verified: true, taskSucceeded: true });
    }
    for (let i = 0; i < 14; i++) {
      cal.record({ oracleName: 'lint', verified: true, taskSucceeded: false });
    }

    const snapshot = cal.get('lint')!;
    expect(snapshot.warm).toBe(true);
    expect(snapshot.accuracy).toBeLessThan(0.5);

    const result = cal.getWeightedConfidence('lint', 0.8);
    // Should be attenuated: 0.8 * (accuracy / 0.5)
    const expected = 0.8 * (snapshot.accuracy / 0.5);
    expect(result).toBeCloseTo(expected, 6);
    expect(result).toBeLessThan(0.8);
  });

  test('oracle at ~50% accuracy returns raw or near-raw confidence', () => {
    const cal = new OracleEMACalibrator();
    // Alternate agree/disagree to approximate 50% accuracy
    for (let i = 0; i < ORACLE_EMA_WARM_THRESHOLD; i++) {
      cal.record({ oracleName: 'type', verified: true, taskSucceeded: i % 2 === 0 });
    }
    const snapshot = cal.get('type')!;
    expect(snapshot.warm).toBe(true);

    const result = cal.getWeightedConfidence('type', 0.8);
    if (snapshot.accuracy >= 0.5) {
      // Above threshold → raw returned
      expect(result).toBe(0.8);
    } else {
      // Below threshold → attenuated by accuracy/0.5
      const expected = 0.8 * (snapshot.accuracy / 0.5);
      expect(result).toBeCloseTo(expected, 6);
    }
  });

  test('unknown oracle returns raw confidence', () => {
    const cal = new OracleEMACalibrator();
    expect(cal.getWeightedConfidence('nonexistent', 0.9)).toBe(0.9);
  });

  test('oracle below warm threshold returns raw confidence', () => {
    const cal = new OracleEMACalibrator();
    // Record a few disagreements — not warm yet
    for (let i = 0; i < ORACLE_EMA_WARM_THRESHOLD - 1; i++) {
      cal.record({ oracleName: 'lint', verified: true, taskSucceeded: false });
    }
    const snapshot = cal.get('lint')!;
    expect(snapshot.warm).toBe(false);
    expect(cal.getWeightedConfidence('lint', 0.8)).toBe(0.8);
  });
});
