/**
 * Failure Cluster Detector — Wave 5. Rolling-window detector that flags when
 * ≥2 tasks with the same signature fail within a configurable time window.
 *
 * Used by the reactive micro-learning path to short-circuit the data-gate:
 * instead of waiting for ≥100 traces for a full sleep cycle, fire a scoped
 * reactive cycle immediately when a failure cluster forms.
 *
 * A3: detection is pure state + time arithmetic. No LLM in the signal path.
 * A5: the rules generated downstream are 'probation' tier and need 3 successful
 *     applications to graduate — no unchecked promotion.
 *
 * This module is standalone and has no store dependencies. Observations are
 * in-memory; callers are responsible for feeding task outcomes into observe().
 */
import type { VinyanBus } from '../../core/bus.ts';

export interface FailureClusterConfig {
  enabled: boolean;
  /** Rolling-window duration in milliseconds. Default 1 hour. */
  windowMs: number;
  /** Minimum failures of the same signature within the window to flag a cluster. */
  minFailures: number;
}

export const DEFAULT_FAILURE_CLUSTER_CONFIG: FailureClusterConfig = {
  enabled: false,
  windowMs: 60 * 60 * 1000,
  minFailures: 2,
};

export interface TaskOutcomeObservation {
  taskSignature: string;
  outcome: 'success' | 'failure';
  timestamp: number;
  taskId: string;
}

export interface FailureCluster {
  taskSignature: string;
  failureCount: number;
  /** Task IDs of the failing observations in the window. */
  taskIds: string[];
  /** Earliest failure timestamp in the cluster. */
  windowStart: number;
  /** Latest failure timestamp in the cluster. */
  windowEnd: number;
}

export class FailureClusterDetector {
  /** Ring buffer of observations, newest last. Bounded at 500 entries. */
  private readonly observations: TaskOutcomeObservation[] = [];
  private static readonly MAX_OBSERVATIONS = 500;
  /** Signatures already reported as clustered; avoids duplicate events. */
  private readonly reported = new Set<string>();

  constructor(
    private readonly cfg: FailureClusterConfig,
    private readonly bus?: VinyanBus,
  ) {}

  /** Record a task outcome. Emits failure:cluster-detected when threshold crossed. */
  observe(obs: TaskOutcomeObservation): FailureCluster | null {
    if (!this.cfg.enabled) return null;

    this.observations.push(obs);
    if (this.observations.length > FailureClusterDetector.MAX_OBSERVATIONS) {
      this.observations.shift();
    }

    // On success, clear the reported flag for this signature so a later
    // streak of failures can re-trigger detection.
    if (obs.outcome === 'success') {
      this.reported.delete(obs.taskSignature);
      return null;
    }

    return this.checkCluster(obs.taskSignature, obs.timestamp);
  }

  /** Query a cluster by signature without observing a new event. */
  getCluster(taskSignature: string, nowMs: number): FailureCluster | null {
    if (!this.cfg.enabled) return null;
    return this.checkCluster(taskSignature, nowMs, /*emit=*/ false);
  }

  private checkCluster(taskSignature: string, nowMs: number, emit: boolean = true): FailureCluster | null {
    const cutoff = nowMs - this.cfg.windowMs;
    const matching = this.observations.filter(
      (o) => o.taskSignature === taskSignature && o.outcome === 'failure' && o.timestamp >= cutoff,
    );

    if (matching.length < this.cfg.minFailures) return null;

    const cluster: FailureCluster = {
      taskSignature,
      failureCount: matching.length,
      taskIds: matching.map((m) => m.taskId),
      windowStart: Math.min(...matching.map((m) => m.timestamp)),
      windowEnd: Math.max(...matching.map((m) => m.timestamp)),
    };

    if (emit && !this.reported.has(taskSignature)) {
      this.reported.add(taskSignature);
      this.bus?.emit('failure:cluster-detected', {
        taskSignature,
        failureCount: cluster.failureCount,
        taskIds: cluster.taskIds,
      });
    }

    return cluster;
  }

  /** Test helper: reset state. */
  reset(): void {
    this.observations.length = 0;
    this.reported.clear();
  }
}
