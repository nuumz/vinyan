/**
 * Worker Lifecycle — deterministic state machine for worker status transitions.
 *
 * Probation → Active → Demoted → Retired
 *
 * Promotion: 30+ tasks, Wilson LB success > median active, quality >= baseline.
 * Demotion: rolling 30 tasks, success < median-0.10 OR quality < median-2σ.
 * Retired: 3 demotions = permanent (no return).
 *
 * Source of truth: design/implementation-plan.md §Phase 4.2
 */

import type { VinyanBus } from '../../core/bus.ts';
import type { WorkerStore } from '../../db/worker-store.ts';
import { wilsonLowerBound } from '../../sleep-cycle/wilson.ts';
import type { WorkerProfile } from '../types.ts';

export interface WorkerLifecycleConfig {
  workerStore: WorkerStore;
  bus?: VinyanBus;
  probationMinTasks: number; // default: 30
  demotionWindowTasks: number; // default: 30
  demotionMaxReentries: number; // default: 3
  reentryCooldownSessions: number; // default: 50
}

export interface PromotionResult {
  promoted: boolean;
  reason: string;
}

export interface DemotionResult {
  demoted: boolean;
  permanent: boolean;
  reason: string;
}

/**
 * Book-integration Wave 4.3: worker cleanup hook.
 *
 * Source: Ch14 Failure 4 (orphaned worktrees). The generalized rule is
 * "every ephemeral isolation mechanism needs a cleanup stage on retire".
 * Vinyan doesn't currently use worktrees, but having a hook registry in
 * the lifecycle makes it trivial to wire one (or any other cleanup —
 * tmp-dir sandbox, scratch DB, cached credentials) without touching
 * WorkerLifecycle's core state machine.
 *
 * Hooks are best-effort — an exception in a hook never blocks the
 * lifecycle transition because cleanup is a hygiene concern, not a
 * correctness requirement.
 *
 * The `reason` argument distinguishes the two trigger cases:
 *   - 'demoted':  temporary removal, worker may re-enroll later
 *   - 'retired':  permanent removal, worker will not return
 */
export type WorkerCleanupHook = (workerId: string, reason: 'demoted' | 'retired') => Promise<void> | void;

export class WorkerLifecycle {
  private store: WorkerStore;
  private bus?: VinyanBus;
  private config: WorkerLifecycleConfig;
  /**
   * Wave 4.3: cleanup hook registry. Populated via `onCleanup()`.
   * Fired on every transition into `demoted` or `retired`. Empty
   * by default — the registry is a seam, not a concrete wiring.
   */
  private cleanupHooks: WorkerCleanupHook[] = [];

  constructor(config: WorkerLifecycleConfig) {
    this.store = config.workerStore;
    this.bus = config.bus;
    this.config = config;
  }

  /**
   * Wave 4.3: register a cleanup hook. Returns an unsubscribe function
   * so callers can dispose their hook during teardown.
   *
   * Use this to plug in workspace cleanup (worktree removal, tmp-dir
   * sweep, etc.) without touching the lifecycle state machine. Hooks
   * fire on demote and retire — never on re-enrollment, because
   * re-enrolled workers need to keep their state.
   */
  onCleanup(hook: WorkerCleanupHook): () => void {
    this.cleanupHooks.push(hook);
    return () => {
      const idx = this.cleanupHooks.indexOf(hook);
      if (idx >= 0) this.cleanupHooks.splice(idx, 1);
    };
  }

  /**
   * Wave 4.3: internal — run all cleanup hooks in order.
   * Exceptions are caught and logged but never thrown; cleanup is a
   * hygiene task and must not unwind the transition.
   */
  private async runCleanupHooks(workerId: string, reason: 'demoted' | 'retired'): Promise<void> {
    for (const hook of this.cleanupHooks) {
      try {
        await hook(workerId, reason);
      } catch (err) {
        // Best-effort: log and continue. A failing cleanup hook must
        // not block the lifecycle transition.
        console.warn(
          `[worker-lifecycle] cleanup hook threw for worker=${workerId} reason=${reason}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  /**
   * Evaluate whether a probation worker should be promoted.
   * Called during Sleep Cycle.
   */
  evaluatePromotion(workerId: string): PromotionResult {
    const profile = this.store.findById(workerId);
    if (!profile || profile.status !== 'probation') {
      return { promoted: false, reason: 'not on probation' };
    }

    const stats = this.store.getStats(workerId);

    // Gate 1: minimum observations
    if (stats.totalTasks < this.config.probationMinTasks) {
      return { promoted: false, reason: `insufficient tasks: ${stats.totalTasks}/${this.config.probationMinTasks}` };
    }

    // Gate 2: Wilson LB of success rate > active worker median
    const activeMedian = this.getActiveWorkerMedianSuccessRate();
    const successCount = Math.round(stats.successRate * stats.totalTasks);
    const wilsonLB = wilsonLowerBound(successCount, stats.totalTasks);
    if (wilsonLB <= activeMedian) {
      return {
        promoted: false,
        reason: `Wilson LB ${wilsonLB.toFixed(3)} <= active median ${activeMedian.toFixed(3)}`,
      };
    }

    // Gate 3: quality >= baseline
    const baselineQuality = this.getActiveWorkerBaselineQuality();
    if (stats.avgQualityScore < baselineQuality) {
      return {
        promoted: false,
        reason: `quality ${stats.avgQualityScore.toFixed(3)} < baseline ${baselineQuality.toFixed(3)}`,
      };
    }

    // Gate 4: zero safety violations during probation period
    const safetyViolations = this.countSafetyViolations(workerId, profile.createdAt);
    if (safetyViolations > 0) {
      return { promoted: false, reason: `${safetyViolations} safety violation(s) during probation` };
    }

    // All gates passed — promote
    this.store.updateStatus(workerId, 'active');
    this.bus?.emit('worker:promoted', {
      workerId,
      afterTasks: stats.totalTasks,
      successRate: stats.successRate,
    });

    return { promoted: true, reason: 'all promotion gates passed' };
  }

  /**
   * Check all active workers for demotion.
   * Called during Sleep Cycle — NOT per-task.
   */
  checkDemotions(): DemotionResult[] {
    const activeWorkers = this.store.findActive();
    const results: DemotionResult[] = [];

    if (activeWorkers.length <= 1) {
      // I8: cannot demote the last active worker
      return results;
    }

    const medianSuccess = this.getActiveWorkerMedianSuccessRate();
    const { medianQuality, stddevQuality } = this.getActiveWorkerQualityStats();

    for (const worker of activeWorkers) {
      // Use rolling window of last N tasks (not lifetime average) per plan PH4.2
      const stats = this.store.getRecentStats(worker.id, this.config.demotionWindowTasks);

      // Need minimum observations in the demotion window
      if (stats.totalTasks < this.config.demotionWindowTasks) continue;

      let shouldDemote = false;
      let reason = '';

      // Trigger 1: success rate drops below median - 0.10
      if (stats.successRate < medianSuccess - 0.1) {
        shouldDemote = true;
        reason = `success rate ${stats.successRate.toFixed(3)} < threshold ${(medianSuccess - 0.1).toFixed(3)}`;
      }

      // Trigger 2: quality below median - 2σ
      if (!shouldDemote && stats.avgQualityScore < medianQuality - 2 * stddevQuality) {
        shouldDemote = true;
        reason = `quality ${stats.avgQualityScore.toFixed(3)} < threshold ${(medianQuality - 2 * stddevQuality).toFixed(3)}`;
      }

      if (!shouldDemote) continue;

      // I8: don't demote if this would leave 0 active workers
      if (activeWorkers.length - results.filter((r) => r.demoted).length <= 1) {
        results.push({ demoted: false, permanent: false, reason: 'I8: would leave 0 active workers' });
        continue;
      }

      // Check for permanent retirement (3 demotions)
      const newDemotionCount = worker.demotionCount + 1;
      const permanent = newDemotionCount >= this.config.demotionMaxReentries;

      if (permanent) {
        this.store.updateStatus(worker.id, 'retired', reason);
      } else {
        this.store.updateStatus(worker.id, 'demoted', reason);
      }

      this.bus?.emit('worker:demoted', {
        workerId: worker.id,
        reason,
        permanent,
      });

      // Wave 4.3: fire cleanup hooks after the state transition is
      // recorded so a hook exception cannot corrupt the store. We
      // deliberately fire-and-forget the async Promise so the hook
      // list cannot extend `checkDemotions()` wall-clock time.
      void this.runCleanupHooks(worker.id, permanent ? 'retired' : 'demoted');

      results.push({ demoted: true, permanent, reason });
    }

    return results;
  }

  /**
   * Re-enroll expired demoted workers (after cooldown period).
   * Cooldown is trace-count based: each worker needs reentryCooldownSessions traces since demotion.
   * Returns list of re-enrolled worker IDs.
   */
  reEnrollExpired(_totalTraceCount?: number): string[] {
    const demotedWorkers = this.store.findByStatus('demoted');
    const reEnrolled: string[] = [];

    for (const worker of demotedWorkers) {
      // Skip if already at max re-entries
      if (worker.demotionCount >= this.config.demotionMaxReentries) {
        // Should be RETIRED, fix state
        this.store.updateStatus(worker.id, 'retired', 'max re-entries reached');
        // Wave 4.3: retirement here is a state-repair case — the
        // worker was previously demoted but the reentry path found
        // it's actually out of budget. Fire cleanup hooks so any
        // ephemeral state attached to it also gets reaped.
        void this.runCleanupHooks(worker.id, 'retired');
        continue;
      }

      // Check cooldown: count traces (proxy for sessions) since demotion
      if (!worker.demotedAt) continue;
      const tracesSinceDemotion = this.store.countTracesSince(worker.id, worker.demotedAt);
      if (tracesSinceDemotion < this.config.reentryCooldownSessions) continue;

      this.store.reEnroll(worker.id);
      this.bus?.emit('worker:reactivated', {
        workerId: worker.id,
        previousDemotionCount: worker.demotionCount,
      });
      reEnrolled.push(worker.id);
    }

    return reEnrolled;
  }

  /**
   * Check if a probation worker should be dispatched for shadow validation.
   * 20% dispatch rate for probation workers.
   */
  /** Check if a worker is currently on probation. */
  isOnProbation(workerId: string): boolean {
    const profile = this.store.findById(workerId);
    return profile?.status === 'probation';
  }

  shouldShadowForProbation(_taskId: string, _workerId: string): boolean {
    return Math.random() < 0.2;
  }

  /**
   * Emergency reactivation: if no active workers remain, reactivate the best demoted worker.
   * Called as safety net — I8 should prevent this from being needed.
   */
  emergencyReactivation(): string | null {
    const active = this.store.findActive();
    if (active.length > 0) return null;

    const demoted = this.store.findByStatus('demoted');
    if (demoted.length === 0) return null;

    // Pick the one with best stats
    let best: WorkerProfile | null = null;
    let bestQuality = -1;
    for (const w of demoted) {
      const stats = this.store.getStats(w.id);
      if (stats.avgQualityScore > bestQuality) {
        bestQuality = stats.avgQualityScore;
        best = w;
      }
    }

    if (!best) return null;

    // Emergency reactivation skips probation — go straight to active
    this.store.updateStatus(best.id, 'active');
    this.bus?.emit('fleet:emergency_reactivation', {
      workerId: best.id,
      reason: 'no active workers remaining',
    });
    return best.id;
  }

  // ── Private helpers ────────────────────────────────────────────────

  private getActiveWorkerMedianSuccessRate(): number {
    const activeWorkers = this.store.findActive();
    if (activeWorkers.length === 0) return 0;

    const rates = activeWorkers.map((w) => this.store.getStats(w.id).successRate).sort((a, b) => a - b);

    const mid = Math.floor(rates.length / 2);
    return rates.length % 2 === 0 ? (rates[mid - 1]! + rates[mid]!) / 2 : rates[mid]!;
  }

  private getActiveWorkerBaselineQuality(): number {
    const activeWorkers = this.store.findActive();
    if (activeWorkers.length === 0) return 0;

    const qualities = activeWorkers.map((w) => this.store.getStats(w.id).avgQualityScore);
    return qualities.reduce((a, b) => a + b, 0) / qualities.length;
  }

  /**
   * Count safety violations during probation using two signals:
   * 1. Bus-emitted guardrail events (tracked in-memory via safetyViolationCounts)
   * 2. Fallback: conservative proxy if worker has zero successes across 5+ tasks
   */
  private safetyViolationCounts = new Map<string, number>();

  /** Subscribe to guardrail bus events for accurate safety tracking. */
  subscribeToGuardrailEvents(): void {
    if (!this.bus) return;
    this.bus.on('guardrail:violation', ({ workerId }: { workerId: string }) => {
      this.safetyViolationCounts.set(workerId, (this.safetyViolationCounts.get(workerId) ?? 0) + 1);
    });
  }

  private countSafetyViolations(workerId: string, sinceTimestamp: number): number {
    // Primary: check bus-tracked violations
    const busCount = this.safetyViolationCounts.get(workerId) ?? 0;
    if (busCount > 0) return busCount;

    // Fallback: conservative proxy from trace stats
    const stats = this.store.getStatsSince(workerId, sinceTimestamp);
    if (stats.totalTasks >= 5 && stats.successRate === 0) {
      return stats.totalTasks;
    }
    return 0;
  }

  private getActiveWorkerQualityStats(): { medianQuality: number; stddevQuality: number } {
    const activeWorkers = this.store.findActive();
    if (activeWorkers.length === 0) return { medianQuality: 0, stddevQuality: 0 };

    const qualities = activeWorkers.map((w) => this.store.getStats(w.id).avgQualityScore).sort((a, b) => a - b);

    const mid = Math.floor(qualities.length / 2);
    const medianQuality = qualities.length % 2 === 0 ? (qualities[mid - 1]! + qualities[mid]!) / 2 : qualities[mid]!;

    const mean = qualities.reduce((a, b) => a + b, 0) / qualities.length;
    const variance = qualities.reduce((sum, q) => sum + (q - mean) ** 2, 0) / qualities.length;
    const stddevQuality = Math.sqrt(variance);

    return { medianQuality, stddevQuality };
  }
}
