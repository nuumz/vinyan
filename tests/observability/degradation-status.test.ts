/**
 * A9 / T4 — DegradationStatusTracker unit tests.
 */

import { describe, expect, test } from 'bun:test';
import { createBus } from '../../src/core/bus.ts';
import { attachDegradationEventBridge } from '../../src/orchestrator/degradation-strategy.ts';
import { DegradationStatusTracker } from '../../src/observability/degradation-status.ts';

describe('DegradationStatusTracker', () => {
  test('records and exposes degradation events from bus', () => {
    const bus = createBus();
    const bridge = attachDegradationEventBridge(bus);
    const tracker = new DegradationStatusTracker();
    const detach = tracker.attach(bus);

    bus.emit('shadow:failed', {
      job: { id: 'sh-1', taskId: 't-1', status: 'failed', enqueuedAt: 1, retryCount: 0, maxRetries: 1 },
      error: 'kaput',
    });

    const snap = tracker.snapshot();
    expect(snap.total).toBe(1);
    expect(snap.entries[0]?.component).toBe('shadow-runner');
    expect(snap.entries[0]?.failureType).toBe('oracle-unavailable');
    expect(snap.failClosedCount).toBe(0);

    detach();
    bridge.detach();
  });

  test('latest event for same (component, failureType) overwrites prior', () => {
    const tracker = new DegradationStatusTracker({ entryTtlMs: 0 });
    tracker.record({
      taskId: 't1',
      failureType: 'oracle-unavailable',
      component: 'oracle:lint',
      action: 'fallback',
      capabilityImpact: 'reduced',
      severity: 'warning',
      retryable: true,
      reason: 'first',
      sourceEvent: 'circuit:open',
      occurredAt: 100,
      policyVersion: 'degradation-strategy:v2',
    });
    tracker.record({
      taskId: 't2',
      failureType: 'oracle-unavailable',
      component: 'oracle:lint',
      action: 'fallback',
      capabilityImpact: 'reduced',
      severity: 'warning',
      retryable: true,
      reason: 'second',
      sourceEvent: 'circuit:open',
      occurredAt: 200,
      policyVersion: 'degradation-strategy:v2',
    });
    const snap = tracker.snapshot();
    expect(snap.total).toBe(1);
    expect(snap.entries[0]?.reason).toBe('second');
    expect(snap.entries[0]?.lastTaskId).toBe('t2');
  });

  test('counts fail-closed entries separately', () => {
    const tracker = new DegradationStatusTracker({ entryTtlMs: 0 });
    tracker.record({
      taskId: 'tw',
      failureType: 'mutation-apply-failure',
      component: 'tool:replace_string_in_file',
      action: 'fail-closed',
      capabilityImpact: 'blocked',
      severity: 'critical',
      retryable: false,
      reason: 'workspace mismatch',
      sourceEvent: 'tool:mutation_failed',
      occurredAt: 50,
      policyVersion: 'degradation-strategy:v2',
    });
    const snap = tracker.snapshot();
    expect(snap.failClosedCount).toBe(1);
  });

  test('recover() clears specific component+failureType', () => {
    const tracker = new DegradationStatusTracker({ entryTtlMs: 0 });
    tracker.record({
      failureType: 'oracle-unavailable',
      component: 'oracle:lint',
      action: 'fallback',
      capabilityImpact: 'reduced',
      severity: 'warning',
      retryable: true,
      reason: 'x',
      sourceEvent: 'circuit:open',
      occurredAt: 1,
      policyVersion: 'degradation-strategy:v2',
    });
    tracker.recover('oracle:lint', 'oracle-unavailable');
    expect(tracker.snapshot().total).toBe(0);
  });

  test('recover() with no failureType clears all entries for that component', () => {
    const tracker = new DegradationStatusTracker({ entryTtlMs: 0 });
    for (const ft of ['oracle-unavailable', 'tool-failure'] as const) {
      tracker.record({
        failureType: ft,
        component: 'oracle:lint',
        action: 'fallback',
        capabilityImpact: 'reduced',
        severity: 'warning',
        retryable: true,
        reason: 'x',
        sourceEvent: 'circuit:open',
        occurredAt: 1,
        policyVersion: 'degradation-strategy:v2',
      });
    }
    tracker.recover('oracle:lint');
    expect(tracker.snapshot().total).toBe(0);
  });

  test('TTL evicts stale entries on snapshot', () => {
    const tracker = new DegradationStatusTracker({ entryTtlMs: 10 });
    tracker.record({
      failureType: 'oracle-unavailable',
      component: 'oracle:lint',
      action: 'fallback',
      capabilityImpact: 'reduced',
      severity: 'warning',
      retryable: true,
      reason: 'x',
      sourceEvent: 'circuit:open',
      occurredAt: 1000,
      policyVersion: 'degradation-strategy:v2',
    });
    expect(tracker.snapshot(1005).total).toBe(1);
    expect(tracker.snapshot(2000).total).toBe(0);
  });

  test('TTL=0 disables eviction', () => {
    const tracker = new DegradationStatusTracker({ entryTtlMs: 0 });
    tracker.record({
      failureType: 'oracle-unavailable',
      component: 'oracle:lint',
      action: 'fallback',
      capabilityImpact: 'reduced',
      severity: 'warning',
      retryable: true,
      reason: 'x',
      sourceEvent: 'circuit:open',
      occurredAt: 0,
      policyVersion: 'degradation-strategy:v2',
    });
    expect(tracker.snapshot(Number.MAX_SAFE_INTEGER).total).toBe(1);
  });
});
