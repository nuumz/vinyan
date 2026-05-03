/**
 * Incident fixture — task `b80c5c0d-3f0e-4f29-9d94-3a88b6b4f052` recorded
 * 2026-05-03 17:00:17 → 17:03:17.
 *
 * Captured straight from the operator's `.vinyan/vinyan.db.task_events`
 * for the parent task and the failing sub-agent round
 * `…-delegate-p-architect-r1`. Only the timestamps and budget values
 * load-bearing for the wall-clock budget regression are pinned here —
 * the full event log lives in the production database, this file is a
 * minimal slice for regression replay.
 *
 * What the timeline proves (see `budget-clamp-incident-replay.test.ts`):
 *   - The architect-r1 sub-agent timed out at sub-task `elapsedMs=104_089`,
 *     ~44s past its 60_000ms budget — because `worker:dispatch.routing
 *     .latencyBudgetMs=59_739` was emitted verbatim from the loop-top
 *     cap value, never re-clamped at dispatch.
 *   - The clamp at the dispatch site (`phase-generate.ts` after the fix)
 *     would have produced `latencyBudgetMs=15_428` instead, capping the
 *     subprocess so it would have returned by sub-task elapsed ≈ 59_750ms
 *     (within budget), leaving the parent's wall-clock budget intact for
 *     the coordinator step that actually ran in 10.8s.
 */

/** Parent root task. */
export const parentTaskTimeline = {
  taskId: 'b80c5c0d-3f0e-4f29-9d94-3a88b6b4f052',
  /** `task:start` event ts. */
  startedAt: 1_777_802_417_075,
  /** Parent's `budget.maxDurationMs`. */
  budgetMs: 180_000,
  /** `task:complete` event ts (status=completed, real synthesized answer). */
  completedAt: 1_777_802_597_418,
  /** Final reported `trace.durationMs` on the completed task. */
  reportedDurationMs: 180_026,
  /** `workflow:step_start` ts for the synth-coordinator step. */
  coordinatorStartedAt: 1_777_802_586_591,
  /** `workflow:step_complete` ts for the synth-coordinator step (status=completed). */
  coordinatorCompletedAt: 1_777_802_597_414,
} as const;

/**
 * Sub-agent round `…-delegate-p-architect-r1` — the round that produced
 * the misleading "Failed: Task timed out after 105s (budget: 60s)" UI
 * banner the operator saw. Sourced from the same `task_events` rows
 * (`task_id` = `b80c5c0d-…-delegate-p-architect-r1`).
 */
export const architectR1Timeline = {
  taskId: 'b80c5c0d-3f0e-4f29-9d94-3a88b6b4f052-delegate-p-architect-r1',
  /** `task:start` event ts (sub-task entry into executeTaskCore). */
  startedAt: 1_777_802_481_152,
  /** Sub-task's own `budget.maxDurationMs` (from `deriveSubBudget`). */
  budgetMs: 60_000,
  /** `worker:dispatch` event ts (44_322ms after sub-task start). */
  dispatchAt: 1_777_802_525_474,
  /** `worker:dispatch.routing.latencyBudgetMs` — the bypassed cap value. */
  dispatchedLatencyBudgetMs: 59_739,
  /** `worker:complete` event ts (subprocess returned with timeout uncertainty). */
  workerCompleteAt: 1_777_802_585_229,
  /** `worker:complete` reported `durationMs` (subprocess ran the full budget). */
  workerDurationMs: 59_752,
  /** `task:timeout` event ts (next routing-loop iteration finally fired). */
  timeoutEmittedAt: 1_777_802_585_241,
  /** `task:timeout.elapsedMs` — sub-task wall-clock when timeout fired. */
  timeoutElapsedMs: 104_089,
  /** `task:timeout.budgetMs` — what the watchdog reported. */
  timeoutBudgetMs: 60_000,
} as const;
