/**
 * Approval Gate — pauses workflow execution until the user (or, for
 * `agent-discretion` mode, Vinyan's deferred rule-based judgement) decides.
 *
 * Wiring (see workflow-executor.ts):
 *   1. Executor builds the plan (planner + research injection).
 *   2. Executor calls `classifyApprovalRequirement(config, goal, plan)` to
 *      pick a `WorkflowApprovalMode`:
 *        - 'none'             → dispatch immediately.
 *        - 'agent-discretion' → wait, on timeout call `evaluateAutoApproval`.
 *        - 'human-required'   → wait, on timeout fail with "human decision
 *                                required" — NEVER auto-approve.
 *   3. For both blocking modes, executor subscribes via
 *      `awaitApprovalDecision` FIRST (to avoid a race) and then emits
 *      `workflow:plan_ready` with `awaitingApproval: true` and the resolved
 *      `approvalMode` + `timeoutMs` so the UI renders correct copy.
 *   4. TUI / HTTP / WS surfaces the plan. The user types approve/reject (or
 *      the timeout expires).
 *   5. Approval client emits `workflow:plan_approved` or
 *      `workflow:plan_rejected`. The executor wakes; steps run (approved) or
 *      a failed `WorkflowResult` is returned (rejected / human-required
 *      timeout / agent-discretion auto-reject).
 *
 * A3 note: the gate itself is rule-based (no LLM). Decision events are
 * authored by the user (or by `evaluateAutoApproval` in
 * `agent-discretion` mode only); timeouts are deterministic.
 */

import type { VinyanBus } from '../../core/bus.ts';
import type { VinyanConfig } from '../../config/schema.ts';
import type { WorkflowPlan, WorkflowStep } from './types.ts';

export type ApprovalDecision = 'approved' | 'rejected' | 'timeout';

/**
 * Approval mode for a workflow plan. Decided by `classifyApprovalRequirement`
 * over the resolved plan + config + goal — deterministic, A3-compliant.
 *
 *   - `none`             → skip the gate, dispatch immediately.
 *   - `agent-discretion` → wait for human approve/reject; on timeout
 *     `evaluateAutoApproval` decides (read-only → approve; mutating →
 *     reject).
 *   - `human-required`   → ONLY a human may approve/reject. Timeout MUST NOT
 *     auto-approve. The executor surfaces an honest "human decision required"
 *     failure if the timer fires (the runtime must produce a finite
 *     WorkflowResult per the task lifecycle contract).
 */
export type WorkflowApprovalMode = 'none' | 'agent-discretion' | 'human-required';

/** Length threshold for 'auto' mode — goals at or above this are long-form. */
export const AUTO_APPROVAL_LENGTH_THRESHOLD = 60;

/**
 * Default timeout when the config doesn't provide one. 3 minutes.
 *
 * Applies to `agent-discretion` review windows. `human-required` mode does
 * NOT auto-decide on timeout — the executor uses the same window to bound
 * task lifetime but surfaces a "human decision required" failure rather
 * than calling `evaluateAutoApproval`.
 *
 * Lowered from 10 minutes after the user reported that the previous default
 * left agentic-workflow turns idle for too long when the human stepped away.
 */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 180_000;

export type WorkflowConfig = NonNullable<VinyanConfig['workflow']>;

/**
 * Tokens that signal a step needs an actual human decision, not just a
 * "review the plan" sanity check. Matched as whole-word against
 * `description` + `expectedOutput`. Bilingual EN/TH because Vinyan ships
 * with Thai-first chat UX and the planner emits Thai descriptions when the
 * goal is Thai.
 *
 * Conservative on purpose: false-positives here downgrade
 * `agent-discretion` to `human-required` (waits for the human) — the worst
 * case is a slightly slower workflow, never a destructive action without
 * review.
 */
// Individual decision keywords — add new terms here; the regex is built from this list.
// Matched as whole-word (\b) against step description + expectedOutput.
const HUMAN_ONLY_KEYWORDS_EN: string[] = [
  // Simple action verbs
  'confirm', 'choose', 'select', 'clarify', 'decide', 'approve', 'reject',
  // Compound phrases
  'pick(?:\\s+one)?',
  'which\\s+(?:option|one)',
  'cannot\\s+decide',
  'cannot\\s+proceed',
  // Deference phrases
  'need(?:s)?\\s+(?:user|human)\\s+(?:input|decision|confirmation|approval)',
];
const HUMAN_ONLY_MARKERS_EN = new RegExp(`\\b(?:${HUMAN_ONLY_KEYWORDS_EN.join('|')})\\b`, 'i');

// Thai phrases written verbatim — no word-boundary regex semantics in Thai.
const HUMAN_ONLY_MARKERS_TH = [
  'ตรงกับที่อยากได้ไหม',   // "Does this match what you wanted?"
  'ตรงกับที่ต้องการไหม',   // "Does this match what you need?"
  'ให้เลือก',              // "Please choose / select"
  'ต้องการแบบไหน',         // "Which style/type do you want?"
  'ผิดตรงไหน',             // "What part is wrong?"
  'ตัดสินใจ',              // "Decide / make a decision"
  'ยืนยัน',               // "Confirm"
  'อนุมัติ',              // "Approve"
  'ขอความเห็น',            // "Request / seeking opinion"
  'ต้องการให้ผู้ใช้',      // "Needs the user to..."
];

function looksLikeHumanDecisionStep(step: WorkflowStep): boolean {
  if (step.strategy === 'human-input') return true;
  const haystack = `${step.description ?? ''}\n${step.expectedOutput ?? ''}`;
  if (!haystack.trim()) return false;
  if (HUMAN_ONLY_MARKERS_EN.test(haystack)) return true;
  for (const phrase of HUMAN_ONLY_MARKERS_TH) {
    if (haystack.includes(phrase)) return true;
  }
  return false;
}

/**
 * Classify the approval requirement for a workflow plan. Pure: no I/O, no
 * LLM. Run after the planner builds the plan and the executor resolves any
 * research-step injection — input is the final plan that will dispatch.
 *
 * Rules (deterministic, A3 — no LLM in governance path):
 *   1. `requireUserApproval === false`               → 'none'.
 *   2. Plan contains a `human-input` step OR any step description /
 *      expectedOutput hits a human-only marker (en/th choose/confirm/
 *      decide …)                                      → 'human-required'.
 *   3. `requireUserApproval === true`                 → 'agent-discretion'.
 *   4. `requireUserApproval === 'auto'` (default):
 *        - long-form goal (≥ AUTO_APPROVAL_LENGTH_THRESHOLD)
 *                                                     → 'agent-discretion'
 *        - short, clear goal                           → 'none'.
 *
 * Note: `requiresApproval` is preserved as a thin wrapper for callers that
 * only need a boolean (legacy tests, dashboards). Workflow-executor uses
 * this richer classifier.
 */
export function classifyApprovalRequirement(
  config: WorkflowConfig | undefined,
  goal: string,
  plan: WorkflowPlan,
): WorkflowApprovalMode {
  const setting = config?.requireUserApproval ?? 'auto';
  const hasHumanOnlyStep = plan.steps.some(looksLikeHumanDecisionStep);

  if (setting === false) return 'none';
  if (hasHumanOnlyStep) return 'human-required';
  if (setting === true) return 'agent-discretion';
  // 'auto' — short goals skip; long-form goals get a review window.
  return goal.trim().length >= AUTO_APPROVAL_LENGTH_THRESHOLD
    ? 'agent-discretion'
    : 'none';
}

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
 *   - 'timeout' after `timeoutMs` with no decision. Interpretation is the
 *     caller's contract: in `agent-discretion` the executor invokes
 *     `evaluateAutoApproval` to make a rule-based call; in `human-required`
 *     the executor surfaces an honest "human decision required" failure
 *     (NEVER auto-approves).
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
