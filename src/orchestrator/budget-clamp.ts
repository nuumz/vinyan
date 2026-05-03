/**
 * Wall-clock budget clamp — single source of truth for the relationship
 * between a task's wall-clock budget and the per-attempt worker budget.
 *
 * Why the cap belongs at dispatch time, not at routing-loop entry:
 *
 *   The pre-existing cap lived at the top of the routing-loop iteration
 *   (`core-loop.ts` ~ line 2987). Phases (perceive / comprehend / plan /
 *   approval-gate) run between that point and the actual `worker:dispatch`
 *   emit, and they consume real wall-clock time. By the time
 *   `bus.emit('worker:dispatch')` fires, the cap value computed at
 *   loop-top is stale: the worker subprocess gets `latencyBudgetMs` close
 *   to the original task budget instead of the budget that actually remains.
 *
 *   Real incident: task `b80c5c0d-...-delegate-p-architect-r1` had
 *   `budget.maxDurationMs = 60_000`, spent 8s in human approval and 12s
 *   in plan/perceive (sub-task elapsed = 44_322ms at dispatch). Loop-top
 *   cap value of `~59_750ms` was emitted into `worker:dispatch.routing`
 *   verbatim. The worker subprocess used its full 60s, returned with
 *   "Subprocess timeout or crash", and only THEN did the next routing-loop
 *   iteration's wall-clock check fire — emitting `task:timeout` at
 *   `elapsedMs=104_089ms`, ~44s past budget.
 *
 * Contract:
 *   - Single clamp site = immediately before `bus.emit('worker:dispatch')`
 *     in `phase-generate.ts`. The agent-loop's own emit (which uses the
 *     same `routing` object passed through from phase-generate) is
 *     therefore also clamped — no separate cap needed there.
 *   - Returns the SAME object identity when no clamp is necessary, so
 *     downstream identity checks aren't disturbed. Returns a shallow
 *     clone otherwise.
 *   - Floor at `WALL_CLOCK_FLOOR_MS` so a near-exhausted budget still
 *     gets enough time for the worker to receive at least one streaming
 *     token before its timeout fires (matches the existing
 *     `Math.max(1_000, …)` floor at the old loop-top cap).
 */
import type { RoutingDecision } from './types.ts';

/**
 * Refuse to start a new attempt with less than this much wall-clock
 * remaining. Same value the legacy loop-top check used. Kept small so
 * existing tight-budget tests (5s/10s) still execute their first attempt.
 */
export const WALL_CLOCK_SAFETY_MS = 250;

/**
 * Per-attempt floor. The worker subprocess + LLM proxy + agent contract
 * all need at least this long to receive a single streaming token before
 * declaring the attempt a failure. Without the floor, a near-exhausted
 * budget would clamp `latencyBudgetMs` to ~0 and every attempt would
 * report a misleading "subprocess timeout" instead of an honest budget
 * exhaustion.
 */
export const WALL_CLOCK_FLOOR_MS = 1_000;

export interface ClampInput {
  routing: RoutingDecision;
  startTime: number;
  maxDurationMs: number;
  /** Defaults to `Date.now`; override in tests for deterministic clamping. */
  now?: () => number;
  /** Defaults to {@link WALL_CLOCK_SAFETY_MS}. */
  safetyMs?: number;
  /** Defaults to {@link WALL_CLOCK_FLOOR_MS}. */
  floorMs?: number;
}

/**
 * Clamp `routing.latencyBudgetMs` to whatever wall-clock budget remains
 * after subtracting `now() - startTime` and the safety margin. When the
 * incoming `latencyBudgetMs` already fits, returns the input object
 * unchanged (identity preserved).
 *
 * The floor (`WALL_CLOCK_FLOOR_MS`) wins over the remaining-budget value:
 * a near-exhausted budget still produces `floorMs`, NOT zero. Callers
 * that need a hard "refuse to start" decision should use the upstream
 * `remainingMs <= WALL_CLOCK_SAFETY_MS` check (`core-loop.ts`).
 */
export function clampRoutingToWallClock(input: ClampInput): RoutingDecision {
  const { routing, startTime, maxDurationMs } = input;
  const now = input.now ?? Date.now;
  const safetyMs = input.safetyMs ?? WALL_CLOCK_SAFETY_MS;
  const floorMs = input.floorMs ?? WALL_CLOCK_FLOOR_MS;

  const elapsedMs = now() - startTime;
  const remainingMs = maxDurationMs - elapsedMs;
  const usableMs = remainingMs - safetyMs;

  if (routing.latencyBudgetMs <= usableMs) return routing;

  const clamped = Math.max(floorMs, usableMs);
  return { ...routing, latencyBudgetMs: clamped };
}

/**
 * Format the user-facing wall-clock timeout banner. Single source so
 * both the orchestrator's `task:complete` answer field and any future
 * surface that re-renders this message stay in lockstep.
 *
 * Honest about the overshoot: when `elapsedMs > budgetMs`, the message
 * names the overage explicitly so operators can tell whether the worker
 * exceeded its budget or whether the task was simply mis-budgeted.
 */
export interface TimeoutMessageInput {
  elapsedMs: number;
  budgetMs: number;
  routingLevel: number;
  /** Optional diagnostics line ("stage: plan:ready; last phase: …; plan N/M"). */
  diagnostics?: string;
}

export function formatTimeoutMessage(input: TimeoutMessageInput): string {
  const elapsedS = Math.round(input.elapsedMs / 1000);
  const budgetS = Math.round(input.budgetMs / 1000);
  const overshootS = Math.max(0, elapsedS - budgetS);
  const diagnosticsLine =
    input.diagnostics && input.diagnostics.length > 0 ? ` Last activity — ${input.diagnostics}.` : '';
  const overshoot = overshootS > 0 ? ` — exceeded budget ${budgetS}s by ${overshootS}s` : ` (budget: ${budgetS}s)`;
  return (
    `Task timed out after ${elapsedS}s${overshoot} at routing level L${input.routingLevel}.` +
    diagnosticsLine +
    ' Try narrowing the request, or raise --max-duration if the task legitimately needs more time.'
  );
}
