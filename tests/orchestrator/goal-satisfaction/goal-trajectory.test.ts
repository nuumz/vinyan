import { describe, expect, test } from 'bun:test';
import { GoalTrajectoryTracker } from '../../../src/orchestrator/goal-satisfaction/goal-evaluator.ts';

describe('GoalTrajectoryTracker', () => {
  test('first iteration: momentum=0, delta=0', () => {
    const tracker = new GoalTrajectoryTracker();
    const point = tracker.record(1, 0.5);

    expect(point.iteration).toBe(1);
    expect(point.score).toBe(0.5);
    expect(point.delta).toBe(0);
    expect(point.momentum).toBe(0);
  });

  test('only 2 iterations → isNegativeMomentum returns false', () => {
    const tracker = new GoalTrajectoryTracker();
    tracker.record(1, 0.6);
    tracker.record(2, 0.4); // negative delta

    // Need at least 3 points (consecutiveCount=2 + 1 baseline)
    expect(tracker.isNegativeMomentum(2)).toBe(false);
  });

  test('scores [0.6, 0.5, 0.4] → negative momentum detected after 3rd iteration', () => {
    const tracker = new GoalTrajectoryTracker();
    tracker.record(1, 0.6);
    tracker.record(2, 0.5); // delta=-0.1, momentum = 0.5*(-0.1) + 0.5*0 = -0.05
    tracker.record(3, 0.4); // delta=-0.1, momentum = 0.5*(-0.1) + 0.5*(-0.05) = -0.075

    expect(tracker.isNegativeMomentum(2)).toBe(true);

    const trajectory = tracker.getTrajectory();
    expect(trajectory.negativeMomentumDetected).toBe(true);
    expect(trajectory.currentMomentum).toBeLessThan(0);
    expect(trajectory.points.length).toBe(3);
  });

  test('scores [0.3, 0.6, 0.8] → momentum positive, no detection', () => {
    const tracker = new GoalTrajectoryTracker();
    tracker.record(1, 0.3);
    tracker.record(2, 0.6); // delta=+0.3, momentum > 0
    tracker.record(3, 0.8); // delta=+0.2, momentum > 0

    expect(tracker.isNegativeMomentum(2)).toBe(false);
    expect(tracker.getTrajectory().negativeMomentumDetected).toBe(false);
  });

  test('scores [0.5, 0.4, 0.6] → recovery after dip, no detection', () => {
    const tracker = new GoalTrajectoryTracker();
    tracker.record(1, 0.5);
    tracker.record(2, 0.4); // delta=-0.1, momentum=-0.05
    tracker.record(3, 0.6); // delta=+0.2, momentum=0.5*(0.2)+0.5*(-0.05)=0.075

    // 3rd point has positive momentum → not all recent are negative
    expect(tracker.isNegativeMomentum(2)).toBe(false);
  });

  test('EMA alpha=0.5: momentum = average of current delta and previous momentum', () => {
    const tracker = new GoalTrajectoryTracker();
    tracker.record(1, 1.0);

    const p2 = tracker.record(2, 0.8);
    // delta = -0.2, previousMomentum = 0
    // momentum = 0.5*(-0.2) + 0.5*(0) = -0.1
    expect(p2.delta).toBeCloseTo(-0.2, 6);
    expect(p2.momentum).toBeCloseTo(-0.1, 6);

    const p3 = tracker.record(3, 0.5);
    // delta = -0.3, previousMomentum = -0.1
    // momentum = 0.5*(-0.3) + 0.5*(-0.1) = -0.2
    expect(p3.delta).toBeCloseTo(-0.3, 6);
    expect(p3.momentum).toBeCloseTo(-0.2, 6);
  });

  test('getTrajectory returns copy of points', () => {
    const tracker = new GoalTrajectoryTracker();
    tracker.record(1, 0.5);
    const t1 = tracker.getTrajectory();
    tracker.record(2, 0.6);
    const t2 = tracker.getTrajectory();

    expect(t1.points.length).toBe(1);
    expect(t2.points.length).toBe(2);
  });

  test('four declining iterations → momentum is strongly negative', () => {
    const tracker = new GoalTrajectoryTracker();
    tracker.record(1, 0.8);
    tracker.record(2, 0.6);
    tracker.record(3, 0.4);
    tracker.record(4, 0.2);

    expect(tracker.isNegativeMomentum(2)).toBe(true);
    expect(tracker.isNegativeMomentum(3)).toBe(true);
    expect(tracker.getTrajectory().currentMomentum).toBeLessThan(-0.1);
  });
});
