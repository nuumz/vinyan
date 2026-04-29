/**
 * DegradationStatusTracker — A9 / T4 in-memory operator visibility surface.
 *
 * Listens to `degradation:triggered` and tracks the most recent reason per
 * (component, failureType) pair so dashboards / TUI / API can answer:
 *
 *   - Which components are currently degraded?
 *   - When did each enter degradation, and why?
 *   - What action did the policy assign?
 *
 * Recovery semantics (kept simple by design):
 *   - Each `degradation:triggered` overwrites the entry for its component +
 *     failure type pair.
 *   - Entries auto-clear after a TTL (default 5 minutes) so stale outages
 *     don't hang on the dashboard forever.
 *   - Optional explicit `recover(component)` API for tests / future bus
 *     bridges to reset a known-recovered component.
 */

import type { VinyanBus, VinyanBusEvents } from '../core/bus.ts';

export type DegradationEvent = VinyanBusEvents['degradation:triggered'];

export interface DegradationStatusEntry {
  component: string;
  failureType: DegradationEvent['failureType'];
  action: DegradationEvent['action'];
  capabilityImpact: DegradationEvent['capabilityImpact'];
  severity: DegradationEvent['severity'];
  policyVersion: string;
  reason: string;
  sourceEvent: string;
  occurredAt: number;
  /** Last `taskId` observed; latest event wins. */
  lastTaskId?: string;
}

export interface DegradationStatusSnapshot {
  total: number;
  entries: DegradationStatusEntry[];
  /** Number of currently-active fail-closed entries — useful as a top-line alert. */
  failClosedCount: number;
  /** Server-side wall clock when the snapshot was rendered. */
  generatedAt: number;
}

export interface DegradationStatusTrackerConfig {
  /**
   * Time after which an entry is considered stale and cleared on next read.
   * Default 5 minutes. Set to 0 to disable auto-clear.
   */
  entryTtlMs: number;
}

const DEFAULT_CONFIG: DegradationStatusTrackerConfig = {
  entryTtlMs: 5 * 60 * 1000,
};

export class DegradationStatusTracker {
  /** Keyed by `${component}::${failureType}` so multiple outages on one component remain visible. */
  private entries = new Map<string, DegradationStatusEntry>();
  private config: DegradationStatusTrackerConfig;
  private detachFn: (() => void) | null = null;

  constructor(config?: Partial<DegradationStatusTrackerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  attach(bus: VinyanBus): () => void {
    if (this.detachFn) return this.detachFn;
    const off = bus.on('degradation:triggered', (event) => this.record(event));
    this.detachFn = () => {
      off();
      this.detachFn = null;
    };
    return this.detachFn;
  }

  record(event: DegradationEvent): void {
    const key = `${event.component}::${event.failureType}`;
    this.entries.set(key, {
      component: event.component,
      failureType: event.failureType,
      action: event.action,
      capabilityImpact: event.capabilityImpact,
      severity: event.severity,
      policyVersion: event.policyVersion,
      reason: event.reason,
      sourceEvent: event.sourceEvent,
      occurredAt: event.occurredAt,
      lastTaskId: event.taskId,
    });
  }

  /**
   * Mark a (component, failureType) pair as recovered. When `failureType` is
   * omitted, all entries for the component clear.
   */
  recover(component: string, failureType?: DegradationEvent['failureType']): void {
    if (failureType) {
      this.entries.delete(`${component}::${failureType}`);
      return;
    }
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(`${component}::`)) this.entries.delete(key);
    }
  }

  snapshot(now: number = Date.now()): DegradationStatusSnapshot {
    this.evictStale(now);
    const entries = [...this.entries.values()].sort((a, b) => b.occurredAt - a.occurredAt);
    const failClosedCount = entries.filter((e) => e.action === 'fail-closed').length;
    return {
      total: entries.length,
      entries,
      failClosedCount,
      generatedAt: now,
    };
  }

  reset(): void {
    this.entries.clear();
  }

  private evictStale(now: number): void {
    const ttl = this.config.entryTtlMs;
    if (ttl <= 0) return;
    for (const [key, entry] of this.entries) {
      if (now - entry.occurredAt > ttl) this.entries.delete(key);
    }
  }
}
