/**
 * Yinyan T&R Kernel — L4 Counterfactual Replay (per-task tracker).
 *
 * Stateful sidecar to `counterfactual-constraint.ts`. Tracks how many times
 * counterfactual replay has fired for a given task so the kernel can
 * enforce a hard ceiling: when the budget is exhausted the next failure
 * surfaces as A2 unknown rather than spawning yet another retry that the
 * orchestrator can never afford.
 *
 * Why a separate object: phase-verify lives in the request path and does
 * not own per-task lifetime — the tracker is wired by the factory once
 * per orchestrator and queried from the phase. Same pattern as the
 * existing `DebateBudgetGuard` (see critic/debate-budget-guard.ts).
 *
 * Axiom anchors:
 *   - A2: `consume()` returning `'exhausted'` is a first-class abstain
 *     signal — never overridden by a later "let's try one more time".
 *   - A3: max-retry decisions are pure scalar comparisons, no LLM input.
 *   - A8: `snapshot()` exposes the per-task counter so traces / dashboards
 *     can replay why the kernel stopped retrying.
 */

export interface CounterfactualTrackerOptions {
  /** Hard ceiling on counterfactual retries per task. Default 3. */
  maxRetriesPerTask?: number;
}

export type ConsumeOutcome =
  | { state: 'allow'; remaining: number; consumed: number }
  | { state: 'exhausted'; consumed: number };

const DEFAULT_MAX = 3;

export class CounterfactualTracker {
  private readonly counts = new Map<string, number>();
  private readonly max: number;

  constructor(opts: CounterfactualTrackerOptions = {}) {
    this.max = opts.maxRetriesPerTask ?? DEFAULT_MAX;
  }

  /**
   * Try to consume one counterfactual retry slot for this task. Returns
   * `'allow'` (with remaining slot count) when the budget still has room,
   * `'exhausted'` when the cap has already been hit.
   *
   * IMPORTANT: this method MUTATES the per-task counter on `'allow'`. The
   * caller is the orchestrator phase that decided "yes, retry with the
   * counterfactual constraints" — once consumed, the slot is gone even
   * if the dispatch later fails for an unrelated reason. That's the right
   * trade-off: the LLM did get a counterfactual-augmented prompt, so the
   * budget should reflect that work even if the answer was wrong.
   */
  consume(taskId: string): ConsumeOutcome {
    const used = this.counts.get(taskId) ?? 0;
    if (used >= this.max) return { state: 'exhausted', consumed: used };
    this.counts.set(taskId, used + 1);
    return { state: 'allow', remaining: this.max - (used + 1), consumed: used + 1 };
  }

  /** Read-only check — does NOT consume a slot. Useful for pre-flight UI. */
  remaining(taskId: string): number {
    return Math.max(0, this.max - (this.counts.get(taskId) ?? 0));
  }

  /**
   * Release per-task state — call from the core-loop's `finally` so a
   * long-running orchestrator process does not leak entries across tasks.
   * Same pattern as `CriticEngine.clearTask?(taskId)`.
   */
  clearTask(taskId: string): void {
    this.counts.delete(taskId);
  }

  /** Audit snapshot — used by tests and the dashboard. */
  snapshot(): { perTask: Record<string, number>; max: number } {
    return { perTask: Object.fromEntries(this.counts), max: this.max };
  }
}
