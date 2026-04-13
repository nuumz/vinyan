import { describe, expect, test } from 'bun:test';
import { createBus } from '../../../src/core/bus.ts';
import {
  ORACLE_EMA_COLD_START,
  ORACLE_EMA_MAX,
  ORACLE_EMA_MIN,
  ORACLE_EMA_WARM_THRESHOLD,
  OracleEMACalibrator,
} from '../../../src/orchestrator/phase7/oracle-ema-calibrator.ts';

describe('OracleEMACalibrator', () => {
  test('cold-start oracle reports the vacuous 0.5 baseline', () => {
    const cal = new OracleEMACalibrator();
    const verdict = cal.record({ oracleName: 'type', verified: true, taskSucceeded: true });
    expect(verdict.observationCount).toBe(1);
    // First observation moves the EMA toward 1.0 by α (= 0.3 at obs=0).
    // 0.3 * 1 + 0.7 * 0.5 = 0.65, clamped within [0.1, 0.9].
    expect(verdict.accuracy).toBeCloseTo(0.65, 5);
    expect(verdict.warm).toBe(false);
  });

  test('streak of agreements pushes accuracy toward upper bound but never above ORACLE_EMA_MAX', () => {
    const cal = new OracleEMACalibrator();
    for (let i = 0; i < 200; i++) {
      cal.record({ oracleName: 'type', verified: true, taskSucceeded: true });
    }
    const snap = cal.get('type')!;
    expect(snap.observationCount).toBe(200);
    expect(snap.accuracy).toBeLessThanOrEqual(ORACLE_EMA_MAX);
    expect(snap.accuracy).toBeGreaterThan(0.85); // close to but never at the cap
    expect(snap.warm).toBe(true);
  });

  test('streak of disagreements pushes accuracy toward lower bound but never below ORACLE_EMA_MIN', () => {
    const cal = new OracleEMACalibrator();
    for (let i = 0; i < 200; i++) {
      cal.record({ oracleName: 'type', verified: true, taskSucceeded: false });
    }
    const snap = cal.get('type')!;
    expect(snap.accuracy).toBeGreaterThanOrEqual(ORACLE_EMA_MIN);
    expect(snap.accuracy).toBeLessThan(0.15);
  });

  test('false negative (verified=false, succeeded) counts as disagreement', () => {
    const cal = new OracleEMACalibrator();
    cal.record({ oracleName: 'type', verified: false, taskSucceeded: true });
    const snap = cal.get('type')!;
    // 0.3 * 0 + 0.7 * 0.5 = 0.35
    expect(snap.accuracy).toBeCloseTo(0.35, 5);
  });

  test('warm flag flips at the warm threshold and emits phase7:oracle_calibration', () => {
    const bus = createBus();
    const events: Array<{ oracleName: string; warm: boolean }> = [];
    bus.on('phase7:oracle_calibration', (e) => events.push({ oracleName: e.oracleName, warm: e.warm }));

    const cal = new OracleEMACalibrator({ bus });
    for (let i = 0; i < ORACLE_EMA_WARM_THRESHOLD - 1; i++) {
      cal.record({ oracleName: 'type', verified: true, taskSucceeded: true });
    }
    expect(cal.get('type')!.warm).toBe(false);
    cal.record({ oracleName: 'type', verified: true, taskSucceeded: true });
    expect(cal.get('type')!.warm).toBe(true);

    // A warm-threshold transition must have shown up on the bus.
    const warmTransition = events.find((e) => e.warm === true);
    expect(warmTransition).toBeDefined();
  });

  test('recordTrace fans the same outcome out across all oracles in a verdict map', () => {
    const cal = new OracleEMACalibrator();
    const verdicts = { ast: true, type: true, dep: false };
    const results = cal.recordTrace(verdicts, true);
    expect(results).toHaveLength(3);
    const byName = Object.fromEntries(results.map((r) => [r.oracleName, r]));
    expect(byName.ast!.accuracy).toBeCloseTo(0.65, 5); // verified=true matched success
    expect(byName.type!.accuracy).toBeCloseTo(0.65, 5);
    expect(byName.dep!.accuracy).toBeCloseTo(0.35, 5); // verified=false didn't match success
  });

  test('snapshot returns sorted entries (deterministic order for dashboards)', () => {
    const cal = new OracleEMACalibrator();
    cal.record({ oracleName: 'type', verified: true, taskSucceeded: true });
    cal.record({ oracleName: 'ast', verified: true, taskSucceeded: true });
    cal.record({ oracleName: 'dep', verified: true, taskSucceeded: true });
    const snap = cal.snapshot();
    expect(snap.map((s) => s.oracleName)).toEqual(['ast', 'dep', 'type']);
  });

  test('reset clears one oracle without affecting others', () => {
    const cal = new OracleEMACalibrator();
    cal.record({ oracleName: 'type', verified: true, taskSucceeded: true });
    cal.record({ oracleName: 'ast', verified: true, taskSucceeded: true });
    cal.reset('type');
    expect(cal.get('type')).toBeNull();
    expect(cal.get('ast')).not.toBeNull();
  });

  test('cold-start sentinel constants stay in sync', () => {
    expect(ORACLE_EMA_COLD_START).toBe(0.5);
    expect(ORACLE_EMA_MIN).toBe(0.1);
    expect(ORACLE_EMA_MAX).toBe(0.9);
    expect(ORACLE_EMA_WARM_THRESHOLD).toBe(10);
  });
});
