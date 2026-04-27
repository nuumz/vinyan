/**
 * Approval Gate — pauses workflow execution until the user approves the plan.
 *
 * Wiring (see workflow-executor.ts):
 *   1. Executor builds the plan (planner + research injection).
 *   2. Executor calls `requiresApproval(config, goal)` to decide whether to
 *      pause. When `false`, dispatch continues immediately.
 *   3. When `true`, executor subscribes via `awaitApprovalDecision` FIRST
 *      (to avoid a race) and then emits `workflow:plan_ready` with
 *      `awaitingApproval: true`.
 *   4. TUI / HTTP / WS surfaces the plan. The user types approve/reject (or
 *      the timeout expires).
 *   5. Approval client emits `workflow:plan_approved` or
 *      `workflow:plan_rejected`. The executor wakes, steps run (approved) or
 *      returns a failed `WorkflowResult` (rejected / timeout).
 *
 * A3 note: the gate itself is rule-based (no LLM). Decision events are
 * strictly authored by the user; timeouts are deterministic.
 */

import type { VinyanBus } from '../../core/bus.ts';
import type { VinyanConfig } from '../../config/schema.ts';

export type ApprovalDecision = 'approved' | 'rejected' | 'timeout';

/** Length threshold for 'auto' mode — goals at or above this are long-form. */
export const AUTO_APPROVAL_LENGTH_THRESHOLD = 60;

/** Default timeout when the config doesn't provide one. 10 minutes. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 600_000;

export type WorkflowConfig = NonNullable<VinyanConfig['workflow']>;

/**
 * Decide whether the workflow requires user approval before execution.
 *
 * Semantics of `requireUserApproval`:
 *   - `true`  → always require approval
 *   - `false` → never require
 *   - `'auto'` (default) → require when the goal looks long-form
 *     (`goal.length >= AUTO_APPROVAL_LENGTH_THRESHOLD`). Short goals skip
 *     the gate so quick tasks don't get blocked.
 */
export function requiresApproval(
  config: WorkflowConfig | undefined,
  goal: string,
): boolean {
  const setting = config?.requireUserApproval ?? 'auto';
  if (setting === true) return true;
  if (setting === false) return false;
  return goal.trim().length >= AUTO_APPROVAL_LENGTH_THRESHOLD;
}

/** Read the approval timeout from config; fall back to the module default. */
export function approvalTimeoutMs(config: WorkflowConfig | undefined): number {
  return config?.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
}

/**
 * Wait for the user's approval decision. Resolves with:
 *   - 'approved' when `workflow:plan_approved` arrives for this taskId
 *   - 'rejected' when `workflow:plan_rejected` arrives
 *   - 'timeout' after `timeoutMs` with no decision (treated as implicit
 *     approval by `workflow-executor` — an absent user defaults to allow)
 *
 * Subscription happens inline so callers MUST call this BEFORE emitting
 * `workflow:plan_ready` to avoid missing an approval event that races the
 * emit. The returned promise settles exactly once — events arriving after
 * settlement are ignored.
 */
export function awaitApprovalDecision(
  bus: VinyanBus,
  taskId: string,
  timeoutMs: number,
): Promise<ApprovalDecision> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: ApprovalDecision) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubApprove();
      unsubReject();
      resolve(value);
    };
    const timer = setTimeout(() => settle('timeout'), timeoutMs);
    const unsubApprove = bus.on('workflow:plan_approved', (payload) => {
      if (payload.taskId === taskId) settle('approved');
    });
    const unsubReject = bus.on('workflow:plan_rejected', (payload) => {
      if (payload.taskId === taskId) settle('rejected');
    });
  });
}
