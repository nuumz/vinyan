import { describe, expect, test } from 'bun:test';
import { createBus } from '../../../src/core/bus.ts';
import {
  REGRESSION_BASELINE_MIN,
  REGRESSION_DROP_THRESHOLD,
  REGRESSION_MIN_OBSERVATIONS,
  REGRESSION_RECENT_WINDOW,
  RegressionMonitor,
} from '../../../src/orchestrator/phase7/regression-monitor.ts';

function fillBaseline(monitor: RegressionMonitor, sig: string, successRate: number): void {
  // Push baseline observations first — these become the "old" half of
  // the rolling window. Use a pseudo-random but deterministic pattern.
  for (let i = 0; i < REGRESSION_BASELINE_MIN; i++) {
    monitor.record({ taskTypeSignature: sig, succeeded: i / REGRESSION_BASELINE_MIN < successRate });
  }
}

describe('RegressionMonitor', () => {
  test('does not alert until the minimum observation count is reached', () => {
    const monitor = new RegressionMonitor();
    let alerted = false;
    for (let i = 0; i < REGRESSION_MIN_OBSERVATIONS - 1; i++) {
      const verdict = monitor.record({ taskTypeSignature: 'edit::ts::single', succeeded: i % 2 === 0 });
      if (verdict.alerted) alerted = true;
    }
    expect(alerted).toBe(false);
  });

  test('alerts when recent window drops by more than threshold', () => {
    const bus = createBus();
    const events: Array<{ drop: number }> = [];
    bus.on('phase7:silent_regression', (e) => events.push({ drop: e.drop }));

    const monitor = new RegressionMonitor({ bus });
    // Baseline: 90% success.
    for (let i = 0; i < REGRESSION_BASELINE_MIN; i++) {
      monitor.record({ taskTypeSignature: 'edit::ts::single', succeeded: i % 10 !== 0 });
    }
    // Recent: 50% success — drop of 0.4, well above the 0.10 threshold.
    let alertedVerdict;
    for (let i = 0; i < REGRESSION_RECENT_WINDOW; i++) {
      const v = monitor.record({ taskTypeSignature: 'edit::ts::single', succeeded: i % 2 === 0 });
      if (v.alerted) alertedVerdict = v;
    }
    expect(alertedVerdict).toBeDefined();
    expect(alertedVerdict!.drop).toBeGreaterThan(REGRESSION_DROP_THRESHOLD);
    expect(events).toHaveLength(1);
  });

  test('does not alert when recent rate is comparable to baseline', () => {
    const monitor = new RegressionMonitor();
    // Both halves at ~70% success → drop is ~0 → no alert.
    for (let i = 0; i < REGRESSION_BASELINE_MIN + REGRESSION_RECENT_WINDOW; i++) {
      monitor.record({ taskTypeSignature: 'edit::ts::single', succeeded: i % 10 !== 0 && i % 10 !== 1 && i % 10 !== 2 });
    }
    const verdict = monitor.snapshot()[0]!;
    expect(verdict.alerted).toBe(false);
    expect(Math.abs(verdict.drop)).toBeLessThan(REGRESSION_DROP_THRESHOLD);
  });

  test('cool-down suppresses repeated alerts within the window', () => {
    const bus = createBus();
    let count = 0;
    bus.on('phase7:silent_regression', () => count++);
    const monitor = new RegressionMonitor({ bus });
    fillBaseline(monitor, 'sig', 0.95);
    for (let i = 0; i < REGRESSION_RECENT_WINDOW; i++) {
      monitor.record({ taskTypeSignature: 'sig', succeeded: false });
    }
    // Push another bad observation — the regression is still present
    // but the cool-down should prevent a second alert in the same call.
    monitor.record({ taskTypeSignature: 'sig', succeeded: false });
    expect(count).toBe(1);
  });

  test('snapshot returns one verdict per task type (sorted is irrelevant for tests)', () => {
    const monitor = new RegressionMonitor();
    monitor.record({ taskTypeSignature: 'a', succeeded: true });
    monitor.record({ taskTypeSignature: 'b', succeeded: false });
    const snap = monitor.snapshot();
    expect(snap.map((s) => s.taskTypeSignature).sort()).toEqual(['a', 'b']);
  });

  test('reset clears one task type without affecting others', () => {
    const monitor = new RegressionMonitor();
    monitor.record({ taskTypeSignature: 'a', succeeded: true });
    monitor.record({ taskTypeSignature: 'b', succeeded: true });
    monitor.reset('a');
    const snap = monitor.snapshot();
    expect(snap.map((s) => s.taskTypeSignature)).toEqual(['b']);
  });
});
