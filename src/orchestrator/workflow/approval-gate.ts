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
import type { WorkflowPlan } from './types.ts';

export type ApprovalDecision = 'approved' | 'rejected' | 'timeout';

/** Length threshold for 'auto' mode — goals at or above this are long-form. */
export const AUTO_APPROVAL_LENGTH_THRESHOLD = 60;

/**
 * Default timeout when the config doesn't provide one. 3 minutes.
 *
 * Lowered from 10 minutes after the user reported that the previous default
 * left agentic-workflow turns idle for too long when the human stepped away.
 * Pairs with `evaluateAutoApproval` so the executor exercises judgement on
 * timeout instead of falling through to blanket implicit approval.
 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 180_000;

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

/**
 * Auto-approval verdict produced when the user does not respond before the
 * approval timeout fires. Vinyan exercises rule-based judgement (A3 — no LLM
 * in the governance path) over the plan: approve when every step is
 * read-only / no-side-effect, reject when the plan would mutate code or run
 * a destructive shell command without a human on the line.
 *
 * The verdict is paired with a `rationale` string so the `WorkflowResult`
 * surfaced on rejection can tell the user *why* Vinyan declined to proceed.
 */
export interface AutoApprovalVerdict {
  decision: 'approved' | 'rejected';
  rationale: string;
}

/**
 * Shell command tokens that signal an irreversible side-effect on the user's
 * machine. Matched as whole-word tokens (not substrings) so legitimate paths
 * like `dirname` are not flagged. Conservative on purpose — when in doubt,
 * Vinyan rejects rather than auto-approves a risky plan with no human on the
 * line.
 */
const DESTRUCTIVE_SHELL_PATTERN =
  /\b(?:rm|rmdir|mv|dd|mkfs|shred|chmod|chown|kill|killall|sudo|shutdown|reboot|halt|truncate|tee|curl|wget)\b|>>?\s*[~/.]|2>&1\s*\|/i;

/**
 * Per-step risk classification for the auto-approval evaluator. Public so the
 * UI / dashboards can render the same verdict per row that Vinyan used to
 * decide.
 */
export interface AutoApprovalStepRisk {
  stepId: string;
  /**
   * Why this step is or is not risky. Empty string when the step is safe.
   * Filled with a short, debuggable phrase ("full-pipeline mutates code",
   * `direct-tool runs destructive shell: rm -rf …`) when risky.
   */
  reason: string;
  risky: boolean;
}

/**
 * Decide whether Vinyan should auto-approve a plan whose human reviewer
 * timed out. Pure: no I/O, no LLM, no module state — A3-compliant.
 *
 * Rules (deterministic):
 *   1. `full-pipeline` step → risky (mutates code via the worker pipeline).
 *   2. `direct-tool` step whose `command` matches the destructive shell
 *      pattern → risky (rm/dd/sudo/etc.).
 *   3. `human-input` step → approved-but-no-op: the executor will surface
 *      the input request even on auto-approve, so a human-input step in the
 *      plan is not a reason to reject the whole workflow.
 *   4. Everything else (`knowledge-query`, `llm-reasoning`,
 *      `delegate-sub-agent`, plain `direct-tool` reads) → safe.
 *
 * If any step is risky, the verdict is `rejected` with a rationale listing
 * the offending steps. Otherwise `approved` with a confirmation rationale.
 */
export function evaluateAutoApproval(plan: WorkflowPlan): AutoApprovalVerdict {
  const risks: AutoApprovalStepRisk[] = plan.steps.map((step) => {
    if (step.strategy === 'full-pipeline') {
      return {
        stepId: step.id,
        reason: 'full-pipeline strategy mutates code via worker pipeline',
        risky: true,
      };
    }
    if (step.strategy === 'direct-tool') {
      const command = step.command ?? step.description ?? '';
      if (DESTRUCTIVE_SHELL_PATTERN.test(command)) {
        const preview = command.length > 80 ? `${command.slice(0, 77)}…` : command;
        return {
          stepId: step.id,
          reason: `direct-tool runs destructive shell command: ${preview}`,
          risky: true,
        };
      }
    }
    return { stepId: step.id, reason: '', risky: false };
  });

  const risky = risks.filter((r) => r.risky);
  if (risky.length === 0) {
    return {
      decision: 'approved',
      rationale: `Auto-approved on timeout: every step is read-only / no-side-effect (${plan.steps.length} step${plan.steps.length === 1 ? '' : 's'}, ${plan.steps.map((s) => s.strategy).join(', ')}).`,
    };
  }
  const summary = risky.map((r) => `${r.stepId}: ${r.reason}`).join('; ');
  return {
    decision: 'rejected',
    rationale: `Auto-approval declined on timeout — ${risky.length} risky step${risky.length === 1 ? '' : 's'} require human review: ${summary}.`,
  };
}
