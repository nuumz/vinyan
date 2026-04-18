/**
 * SafetyViolationTracker — bus-subscribed counter for guardrail violations.
 *
 * Extracted from WorkerLifecycle so the counter can be shared across gates.
 * WorkerGates.shouldPromote consults this to block promotion of any engine
 * that violated safety invariants during probation.
 *
 * Fallback: when the bus is absent (tests, edge cases) the tracker exposes a
 * manual `recordViolation()` entry point so consumers can still simulate
 * events in isolation.
 */

import type { VinyanBus } from '../../core/bus.ts';

export class SafetyViolationTracker {
  private counts = new Map<string, number>();

  /** Attach to a bus and count `guardrail:violation` events by workerId. */
  subscribe(bus: VinyanBus): () => void {
    return bus.on('guardrail:violation', ({ workerId }: { workerId: string }) => {
      this.counts.set(workerId, (this.counts.get(workerId) ?? 0) + 1);
    });
  }

  /** Public count for WorkerGates to consult. */
  count(workerId: string): number {
    return this.counts.get(workerId) ?? 0;
  }

  /** Manual entry point — used by tests that don't wire a bus. */
  recordViolation(workerId: string): void {
    this.counts.set(workerId, (this.counts.get(workerId) ?? 0) + 1);
  }

  /** Reset (tests). */
  reset(): void {
    this.counts.clear();
  }
}
