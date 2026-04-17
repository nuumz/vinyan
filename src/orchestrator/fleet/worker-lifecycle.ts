/**
 * WorkerLifecycle — thin wrapper over ProfileLifecycle<EngineProfile>.
 *
 * State machine and gate logic now live in
 *   - src/orchestrator/profile/profile-lifecycle.ts  (generic FSM)
 *   - src/orchestrator/profile/worker-gates.ts       (Wilson LB gates)
 *   - src/orchestrator/profile/safety-violation-tracker.ts  (guardrail counter)
 *   - src/orchestrator/profile/cleanup-hooks.ts      (ephemeral resource teardown)
 *
 * This file composes them behind the original WorkerLifecycle API so every
 * existing call site (factory, sleep-cycle, tests) keeps working without
 * changes.
 *
 * Source of truth: design/implementation-plan.md §Phase 4.2 + unified
 * AgentProfile ultraplan Step 1-5.
 */

import type { VinyanBus } from '../../core/bus.ts';
import type { WorkerStore } from '../../db/worker-store.ts';
import { CleanupHookRegistry, type CleanupHook } from '../profile/cleanup-hooks.ts';
import { ProfileLifecycle } from '../profile/profile-lifecycle.ts';
import { SafetyViolationTracker } from '../profile/safety-violation-tracker.ts';
import { WorkerGates } from '../profile/worker-gates.ts';
import type { EngineProfile } from '../types.ts';

export interface WorkerLifecycleConfig {
  workerStore: WorkerStore;
  bus?: VinyanBus;
  probationMinTasks: number; // default: 30
  demotionWindowTasks: number; // default: 30
  demotionMaxReentries: number; // default: 3
  reentryCooldownSessions: number; // default: 50 traces since demotion
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

/** Alias kept for backward compat of imported signature from cleanup-hooks. */
export type WorkerCleanupHook = CleanupHook;

export class WorkerLifecycle {
  private readonly store: WorkerStore;
  private readonly bus?: VinyanBus;
  private readonly config: WorkerLifecycleConfig;
  private readonly safety = new SafetyViolationTracker();
  private readonly cleanup = new CleanupHookRegistry();
  private readonly lifecycle: ProfileLifecycle<EngineProfile>;

  constructor(config: WorkerLifecycleConfig) {
    this.store = config.workerStore;
    this.bus = config.bus;
    this.config = config;

    const gates = new WorkerGates({
      store: this.store,
      probationMinTasks: config.probationMinTasks,
      demotionWindowTasks: config.demotionWindowTasks,
      safetyViolationCount: (id) => this.safety.count(id),
    });

    this.lifecycle = new ProfileLifecycle<EngineProfile>({
      kind: 'worker',
      store: this.store,
      gates,
      bus: this.bus,
      maxDemotions: config.demotionMaxReentries,
    });
  }

  /**
   * Register a cleanup hook that fires on every transition into `demoted` or
   * `retired`. Returns an unsubscribe function.
   */
  onCleanup(hook: CleanupHook): () => void {
    return this.cleanup.onCleanup(hook);
  }

  /** Evaluate whether a probation worker should be promoted. */
  evaluatePromotion(workerId: string): PromotionResult {
    const verdict = this.lifecycle.evaluatePromotion(workerId);
    return { promoted: verdict.promote, reason: verdict.reason };
  }

  /**
   * Check all active workers for demotion. Invokes cleanup hooks for every
   * worker that moved into `demoted` or `retired`.
   */
  checkDemotions(): DemotionResult[] {
    const transitions = this.lifecycle.checkDemotions();
    const results: DemotionResult[] = [];
    for (const t of transitions) {
      const permanent = t.to === 'retired';
      results.push({ demoted: true, permanent, reason: t.reason });
      void this.cleanup.run(t.id, permanent ? 'retired' : 'demoted');
    }
    return results;
  }

  /**
   * Re-enroll demoted workers whose trace-count cooldown has elapsed.
   * `_totalTraceCount` is accepted for backward compat — the tracking is
   * per-worker via trace counts since demotion.
   */
  reEnrollExpired(_totalTraceCount?: number): string[] {
    const demoted = this.store.findByStatus('demoted');
    const reEnrolled: string[] = [];

    for (const worker of demoted) {
      // Exhaust max re-entries → retire + run cleanup
      if (worker.demotionCount >= this.config.demotionMaxReentries) {
        this.store.updateStatus(worker.id, 'retired', 'max re-entries reached');
        this.bus?.emit('profile:retired', {
          kind: 'worker',
          id: worker.id,
          reason: 'max re-entries reached',
        });
        void this.cleanup.run(worker.id, 'retired');
        continue;
      }

      // Cooldown: wait until N traces have landed since demotion
      if (!worker.demotedAt) continue;
      const tracesSinceDemotion = this.store.countTracesSince(worker.id, worker.demotedAt);
      if (tracesSinceDemotion < this.config.reentryCooldownSessions) continue;

      this.store.reEnroll(worker.id);
      this.bus?.emit('profile:reactivated', { kind: 'worker', id: worker.id });
      reEnrolled.push(worker.id);
    }
    return reEnrolled;
  }

  /**
   * Emergency reactivation: if no active workers remain, reactivate the best
   * demoted worker (highest avg quality). I8 should prevent this from firing.
   */
  emergencyReactivation(): string | null {
    return this.lifecycle.emergencyReactivation((demoted) => {
      let best: EngineProfile | null = null;
      let bestQuality = -1;
      for (const w of demoted) {
        const stats = this.store.getStats(w.id);
        if (stats.avgQualityScore > bestQuality) {
          bestQuality = stats.avgQualityScore;
          best = w;
        }
      }
      return best;
    });
  }

  /** 20% shadow dispatch rate for probation workers. */
  shouldShadowForProbation(_taskId: string, _workerId: string): boolean {
    return Math.random() < 0.2;
  }

  /** Whether a worker is currently on probation. */
  isOnProbation(workerId: string): boolean {
    const profile = this.store.findById(workerId);
    return profile?.status === 'probation';
  }

  /** Subscribe the safety tracker to bus guardrail events. No-op without a bus. */
  subscribeToGuardrailEvents(): void {
    if (!this.bus) return;
    this.safety.subscribe(this.bus);
  }
}
