/**
 * A14 — Plateau Adaptation invariant (proposed RFC, not yet load-bearing).
 *
 * Sleep-cycle emits `sleep:plateau_detected` when consecutive no-op
 * cycles ≥ sentinel threshold AND trace-count is stable. Future
 * plateau-adaptation logic will lower promotion thresholds in a bounded
 * way to admit new candidates; today this stub event is the seam.
 */
import { describe, expect, test } from 'bun:test';
import { EventBus, type VinyanBusEvents } from '../../src/core/bus.ts';

describe('A14 — Plateau Adaptation (RFC stub)', () => {
  test('event shape carries cycleId, consecutiveNoopCycles, threshold', () => {
    const bus = new EventBus<VinyanBusEvents>();
    const captured: VinyanBusEvents['sleep:plateau_detected'][] = [];
    bus.on('sleep:plateau_detected', (p) => captured.push(p));

    bus.emit('sleep:plateau_detected', {
      cycleId: 'cycle-42',
      consecutiveNoopCycles: 5,
      threshold: 5,
    });
    expect(captured.length).toBe(1);
    expect(captured[0]?.cycleId).toBe('cycle-42');
    expect(captured[0]?.consecutiveNoopCycles).toBe(5);
    expect(captured[0]?.threshold).toBe(5);
  });
});
