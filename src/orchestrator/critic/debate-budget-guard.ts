/**
 * Debate Budget Guard — per-task cap on Architecture Debate invocations.
 *
 * Book-integration Wave 5 (partial closure of Phase B §6 backlog item #7).
 *
 * The full Wave 5 backlog #7 asks for a *per-day* debate cost cap at the
 * Economy OS layer. That still needs CostLedger integration. This
 * module ships the simpler sibling: a *per-task* cap that prevents a
 * single task's inner retry loop from firing the 3-seat debate
 * repeatedly.
 *
 * Motivation (from Appendix C + Ch06 cost discussion):
 *   - Each debate is 3 LLM calls, typically Opus-tier at L3.
 *   - A single task that retries N times with riskScore ≥ threshold
 *     would fire the debate N times, multiplying cost by 3×N.
 *   - Operators want to say "debate at most K times per task" as an
 *     explicit bound independent of the token budget.
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
 *   - `recordFired(taskId)` — increment the counter after a debate fires
 *   - `recordDenied(taskId, reason)` — emit observability event when
 *     the cap blocks a would-be debate fire
 *   - `clearTask(taskId)` — release the counter when a task completes
 *     (prevents unbounded growth of the internal Map across a long
 *     orchestrator lifetime)
 *
 * The Map is bounded by the number of concurrently-live tasks, so it
 * does not grow unboundedly in the common case. Callers that care
 * about tight cleanup should call `clearTask` on task completion.
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
   * Optional bus for emitting `critic:debate_denied` when the cap
   * blocks a would-be debate invocation. Absent ⇒ silent deny.
   */
  bus?: VinyanBus;
}

const DEFAULT_MAX_PER_TASK = 1;

export class DebateBudgetGuard {
  private counts = new Map<string, number>();
  private readonly maxPerTask: number;
  private readonly bus?: VinyanBus;

  constructor(config: DebateBudgetGuardConfig = {}) {
    const requested = config.maxPerTask ?? DEFAULT_MAX_PER_TASK;
    this.maxPerTask = Math.max(0, requested);
    this.bus = config.bus;
  }

  /**
   * Read-only check: can a debate fire for this task id right now?
   * Returns `false` when the counter has reached `maxPerTask` or when
   * the guard is configured with `maxPerTask: 0`.
   */
  shouldAllow(taskId: string): boolean {
    if (this.maxPerTask === 0) return false;
    const count = this.counts.get(taskId) ?? 0;
    return count < this.maxPerTask;
  }

  /**
   * Record that a debate fired for the given task. Increments the
   * internal counter. Must be called by the router AFTER
   * `shouldAllow` returns true and BEFORE the debate's LLM calls so
   * concurrent routers see the updated count.
   */
  recordFired(taskId: string): void {
    const count = this.counts.get(taskId) ?? 0;
    this.counts.set(taskId, count + 1);
  }

  /**
   * Record that a debate was denied because the cap was reached.
   * Emits a `critic:debate_denied` bus event if a bus was configured.
   * This is purely observational — the deny decision has already been
   * made by `shouldAllow`.
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
   * manage task lifecycle — the core loop's `executeTask` exit path
   * is the canonical site — should call this when a task leaves the
   * active set to prevent unbounded Map growth across a long-running
   * orchestrator process.
   */
  clearTask(taskId: string): void {
    this.counts.delete(taskId);
  }

  /** Test helper: current count for a given task id. */
  getCount(taskId: string): number {
    return this.counts.get(taskId) ?? 0;
  }

  /** Test helper: snapshot of all currently-tracked task counts. */
  snapshot(): ReadonlyMap<string, number> {
    return new Map(this.counts);
  }
}
