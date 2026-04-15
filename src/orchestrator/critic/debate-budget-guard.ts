/**
 * Debate Budget Guard — per-task + per-day cap on Architecture Debate
 * invocations.
 *
 * Book-integration Wave 5 (Phase B §6 backlog item #7).
 *
 * Motivation (from Appendix C + Ch06 cost discussion):
 *   - Each debate is 3 LLM calls, typically Opus-tier at L3.
 *   - A single task that retries N times with riskScore ≥ threshold
 *     would fire the debate N times, multiplying cost by 3×N.
 *   - Across a whole day of dispatching, even with per-task caps, the
 *     total debate spend can drift. Operators want a secondary ceiling
 *     that bounds the daily debate-fire count across all tasks.
 *
 * Caps (both optional and independent — denying when EITHER is exceeded):
 *   - `maxPerTask`: per-task-id counter, prevents one task from firing
 *     the 3-seat debate more than K times during its inner retry loop.
 *     Default: 1. Setting to 0 disables debate entirely.
 *   - `maxPerDay`: rolling counter of debate fires since the start of
 *     the current UTC day. Default: undefined (no per-day cap).
 *     Setting to 0 disables debate entirely for the whole day.
 *
 * Axiom compliance:
 *   - A3 (deterministic governance): the guard is a pure in-memory
 *     counter + max-comparison. No LLM in the cap decision. The bus
 *     event `critic:debate_denied` is observational, not governance.
 *   - A6 (zero-trust): the guard adds a deny path but never relaxes
 *     an existing authority. A denied debate falls through to the
 *     baseline critic, preserving the zero-trust commit-gate contract.
 *
 * Lifecycle:
 *   - `shouldAllow(taskId)` — read-only check before firing
 *   - `recordFired(taskId)` — increment counters after a debate fires
 *   - `recordDenied(taskId, reason)` — emit observability event
 *   - `clearTask(taskId)` — release the per-task counter
 *
 * State:
 *   - `counts: Map<taskId, number>` — per-task counter
 *   - `fires: number[]` — timestamps of fires, pruned to the current
 *     UTC day on every touch
 *
 * Bounded memory:
 *   - `counts` is bounded by the number of concurrently-live tasks
 *     (call `clearTask` on task completion to release).
 *   - `fires` is bounded by the per-day count (pruned automatically)
 *     or the calling rate — whichever is smaller.
 */
import type { VinyanBus } from '../../core/bus.ts';

export interface DebateBudgetGuardConfig {
  /**
   * Maximum number of debates allowed for any single task id. Default: 1.
   * A setting of 0 disables debate mode entirely (equivalent to forcing
   * `DEBATE:skip` on every task). Negative values are treated as 0.
   */
  maxPerTask?: number;
  /**
   * Wave 5.7b: optional per-day cap. Total number of debate fires
   * allowed between midnight-UTC-today and the next midnight.
   * Undefined ⇒ no day cap (only per-task cap enforced). 0 ⇒ no
   * debates at all today. Negative values are clamped to 0.
   */
  maxPerDay?: number;
  /**
   * Optional bus for emitting `critic:debate_denied` when the cap
   * blocks a would-be debate invocation. Absent ⇒ silent deny.
   */
  bus?: VinyanBus;
  /**
   * Clock injection for testability. Default `Date.now`. Tests that
   * exercise the per-day rollover use a mutable `{ t }` object.
   */
  now?: () => number;
}

const DEFAULT_MAX_PER_TASK = 1;

export class DebateBudgetGuard {
  private counts = new Map<string, number>();
  /** Timestamps (ms) of debate fires, pruned to the current UTC day. */
  private fires: number[] = [];
  private readonly maxPerTask: number;
  private readonly maxPerDay: number | undefined;
  private readonly bus?: VinyanBus;
  private readonly now: () => number;

  constructor(config: DebateBudgetGuardConfig = {}) {
    const requestedTask = config.maxPerTask ?? DEFAULT_MAX_PER_TASK;
    this.maxPerTask = Math.max(0, requestedTask);
    this.maxPerDay = config.maxPerDay === undefined ? undefined : Math.max(0, config.maxPerDay);
    this.bus = config.bus;
    this.now = config.now ?? Date.now;
  }

  /**
   * Read-only check: can a debate fire for this task id right now?
   * Returns `false` when:
   *   - `maxPerTask` is 0, OR
   *   - the per-task counter has reached `maxPerTask`, OR
   *   - `maxPerDay` is set (and > 0) and the day counter has reached it, OR
   *   - `maxPerDay` is 0
   *
   * Side effect: prunes stale day entries before checking. This is
   * cheap (linear scan of at most `maxPerDay` items) and ensures the
   * check is always based on the current UTC day.
   */
  shouldAllow(taskId: string): boolean {
    if (this.maxPerTask === 0) return false;
    const count = this.counts.get(taskId) ?? 0;
    if (count >= this.maxPerTask) return false;

    if (this.maxPerDay !== undefined) {
      if (this.maxPerDay === 0) return false;
      this.pruneStaleFires();
      if (this.fires.length >= this.maxPerDay) return false;
    }
    return true;
  }

  /**
   * Record that a debate fired for the given task. Increments the
   * per-task counter AND appends a timestamp to the per-day counter.
   * Must be called by the router AFTER `shouldAllow` returns true and
   * BEFORE the debate's LLM calls so concurrent routers see the
   * updated counts.
   */
  recordFired(taskId: string): void {
    const count = this.counts.get(taskId) ?? 0;
    this.counts.set(taskId, count + 1);
    this.fires.push(this.now());
    this.pruneStaleFires();
  }

  /**
   * Record that a debate was denied because some cap was reached.
   * Emits a `critic:debate_denied` bus event if a bus was configured.
   * The caller passes a human-readable reason string that distinguishes
   * per-task vs per-day denial (the router does this).
   */
  recordDenied(taskId: string, reason: string): void {
    this.bus?.emit('critic:debate_denied', {
      taskId,
      reason,
      maxPerTask: this.maxPerTask,
      count: this.counts.get(taskId) ?? 0,
    });
  }

  /**
   * Release the counter for a completed (or failed) task. Callers that
   * manage task lifecycle — the core loop's `executeTask` exit path is
   * the canonical site — should call this when a task leaves the
   * active set to prevent unbounded Map growth across a long-running
   * orchestrator process.
   *
   * Note: this does NOT touch the per-day counter. Daily fires are
   * retained until the UTC day rolls over.
   */
  clearTask(taskId: string): void {
    this.counts.delete(taskId);
  }

  /** Test helper: current per-task count for a given task id. */
  getCount(taskId: string): number {
    return this.counts.get(taskId) ?? 0;
  }

  /** Test helper: snapshot of all currently-tracked task counts. */
  snapshot(): ReadonlyMap<string, number> {
    return new Map(this.counts);
  }

  /** Test helper: current number of fires counted against the day cap. */
  getDayCount(): number {
    this.pruneStaleFires();
    return this.fires.length;
  }

  /**
   * Wave 5.7b: discriminator the router can use to build a precise
   * deny reason. Returns the *first* cap the taskId would hit, or
   * `null` if the call would be allowed. Read-only (invokes
   * `pruneStaleFires` but does not mutate counts or fires beyond
   * that housekeeping).
   */
  whyDenied(taskId: string): 'max-per-task' | 'max-per-day' | null {
    if (this.maxPerTask === 0) return 'max-per-task';
    const count = this.counts.get(taskId) ?? 0;
    if (count >= this.maxPerTask) return 'max-per-task';
    if (this.maxPerDay !== undefined) {
      if (this.maxPerDay === 0) return 'max-per-day';
      this.pruneStaleFires();
      if (this.fires.length >= this.maxPerDay) return 'max-per-day';
    }
    return null;
  }

  // ── private ──────────────────────────────────────────────────────

  private pruneStaleFires(): void {
    const dayStart = this.currentDayStart();
    // Fast path: if the oldest fire is still within the day, nothing to do.
    if (this.fires.length === 0 || this.fires[0]! >= dayStart) return;
    this.fires = this.fires.filter((t) => t >= dayStart);
  }

  private currentDayStart(): number {
    const d = new Date(this.now());
    d.setUTCHours(0, 0, 0, 0);
    return d.getTime();
  }
}
