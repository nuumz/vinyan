/**
 * A9 — Resilient Degradation invariant (proposed).
 *
 * Component failure must produce a structured degradation event, not a
 * silent fail. The `DegradationStatusTracker` attaches to the bus and
 * surfaces the most recent (component, failureType) state to operators.
 */
import { describe, expect, test } from 'bun:test';
import { EventBus, type VinyanBusEvents } from '../../src/core/bus.ts';
import { DegradationStatusTracker } from '../../src/observability/degradation-status.ts';

function freshBus(): EventBus<VinyanBusEvents> {
  return new EventBus<VinyanBusEvents>();
}

function emitTriggered(
  bus: EventBus<VinyanBusEvents>,
  overrides: Partial<VinyanBusEvents['degradation:triggered']> = {},
): void {
  bus.emit('degradation:triggered', {
    failureType: 'tool-timeout',
    component: 'oracle.test',
    action: 'fail-closed',
    capabilityImpact: 'reduced',
    retryable: false,
    severity: 'warning',
    policyVersion: 'a9:test',
    reason: 'oracle exceeded 30s',
    sourceEvent: 'oracle:verdict',
    occurredAt: Date.now(),
    ...overrides,
  });
}

describe('A9 — Resilient Degradation', () => {
  test('attached tracker records a triggered degradation', () => {
    const bus = freshBus();
    const tracker = new DegradationStatusTracker();
    tracker.attach(bus);
    emitTriggered(bus);
    const snap = tracker.snapshot();
    expect(snap.total).toBeGreaterThan(0);
    expect(snap.entries.some((e) => e.component === 'oracle.test')).toBe(true);
  });

  test('recover() clears entries for the component+failureType pair', () => {
    const bus = freshBus();
    const tracker = new DegradationStatusTracker();
    tracker.attach(bus);
    emitTriggered(bus);
    expect(tracker.snapshot().total).toBeGreaterThan(0);
    tracker.recover('oracle.test', 'tool-timeout');
    expect(tracker.snapshot().total).toBe(0);
  });

  test('snapshot has fail-closed count when action is fail-closed', () => {
    const bus = freshBus();
    const tracker = new DegradationStatusTracker();
    tracker.attach(bus);
    emitTriggered(bus, { action: 'fail-closed' });
    expect(tracker.snapshot().failClosedCount).toBeGreaterThanOrEqual(1);
  });
});
