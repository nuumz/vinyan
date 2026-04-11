/**
 * Cost signaling tests — Phase K1.
 */
import { describe, expect, test } from 'bun:test';
import { CostTracker } from '../../src/a2a/cost-signal.ts';

const COST_A = { tokens_input: 1000, tokens_output: 500, duration_ms: 2000, oracle_invocations: 3 };
const COST_B = {
  tokens_input: 2000,
  tokens_output: 800,
  duration_ms: 3000,
  oracle_invocations: 5,
  estimated_usd: 0.05,
};

describe('CostTracker — record', () => {
  test('stores cost record', () => {
    const tracker = new CostTracker();
    tracker.record('peer-A', 'task-001', COST_A);
    expect(tracker.getRecordCount()).toBe(1);
  });

  test('increments count on multiple records', () => {
    const tracker = new CostTracker();
    tracker.record('peer-A', 'task-001', COST_A);
    tracker.record('peer-B', 'task-002', COST_B);
    expect(tracker.getRecordCount()).toBe(2);
  });
});

describe('CostTracker — getAverageCost', () => {
  test('computes average across records', () => {
    const tracker = new CostTracker();
    tracker.record('peer-A', 'task-001', COST_A);
    tracker.record('peer-B', 'task-002', COST_B);

    const avg = tracker.getAverageCost();
    expect(avg.tokens_input).toBe(1500);
    expect(avg.tokens_output).toBe(650);
    expect(avg.duration_ms).toBe(2500);
    expect(avg.oracle_invocations).toBe(4);
  });

  test('returns single record values for one record', () => {
    const tracker = new CostTracker();
    tracker.record('peer-A', 'task-001', COST_A);

    const avg = tracker.getAverageCost();
    expect(avg.tokens_input).toBe(1000);
  });

  test('returns zeros when empty', () => {
    const tracker = new CostTracker();
    const avg = tracker.getAverageCost();

    expect(avg.tokens_input).toBe(0);
    expect(avg.tokens_output).toBe(0);
    expect(avg.duration_ms).toBe(0);
    expect(avg.oracle_invocations).toBe(0);
  });
});

describe('CostTracker — getTotalCost', () => {
  test('sums all fields', () => {
    const tracker = new CostTracker();
    tracker.record('peer-A', 'task-001', COST_A);
    tracker.record('peer-B', 'task-002', COST_B);

    const total = tracker.getTotalCost();
    expect(total.tokens_input).toBe(3000);
    expect(total.tokens_output).toBe(1300);
    expect(total.duration_ms).toBe(5000);
    expect(total.oracle_invocations).toBe(8);
  });

  test('sums estimated_usd where present', () => {
    const tracker = new CostTracker();
    tracker.record('peer-A', 'task-001', COST_A); // no estimated_usd
    tracker.record('peer-B', 'task-002', COST_B); // 0.05
    tracker.record('peer-C', 'task-003', { ...COST_A, estimated_usd: 0.03 });

    const total = tracker.getTotalCost();
    expect(total.estimated_usd).toBeCloseTo(0.08);
  });
});

describe('CostTracker — getCostByPeer', () => {
  test('filters by peer', () => {
    const tracker = new CostTracker();
    tracker.record('peer-A', 'task-001', COST_A);
    tracker.record('peer-A', 'task-002', COST_B);
    tracker.record('peer-B', 'task-003', COST_A);

    expect(tracker.getCostByPeer('peer-A')).toHaveLength(2);
    expect(tracker.getCostByPeer('peer-B')).toHaveLength(1);
  });

  test('returns empty for unknown peer', () => {
    const tracker = new CostTracker();
    expect(tracker.getCostByPeer('unknown')).toHaveLength(0);
  });
});
