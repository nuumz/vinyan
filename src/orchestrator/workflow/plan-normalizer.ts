/**
 * Deterministic post-parse normalizer for `WorkflowPlan` (Q1+Q2).
 *
 * Why this exists: the LLM planner is allowed to be wrong. It can
 * forget `fallbackStrategy`, emit one that doesn't make sense, or skip
 * the new `retryBudget` field entirely. The executor must still run
 * with predictable governance behaviour — A3 demands that the same
 * plan + same config produce the same retry/fallback verdict on every
 * replay. So we run a pure rule-based pass after Zod parsing and
 * before the executor sees the plan.
 *
 * Contract:
 *   - Pure function. No I/O, no LLM, no time-dependent branches.
 *   - Same input plan → same output plan, byte-for-byte.
 *   - Never adds steps, never deletes steps, never reorders.
 *   - Only mutates `step.fallbackStrategy`, `step.fallbackOrigin`, and
 *     `step.retryBudget` on individual steps.
 *
 * The two normalizations Vinyan owns today:
 *
 *   1. Q1 — fill in `retryBudget` defaults.
 *      - delegate-sub-agent steps default to {@link DEFAULT_DELEGATE_RETRY_BUDGET}.
 *      - everything else defaults to 0 (preserves legacy single-attempt).
 *      - Already-set values are CLAMPED to [0, MAX_STEP_RETRY_BUDGET]
 *        rather than rejected, so a planner that emits a too-large
 *        budget cannot blow past the safety cap. Zod also rejects
 *        out-of-range at parse time but the runtime clamp matches the
 *        executor's resolver, so the plan's persisted shape is what the
 *        executor will actually use.
 *
 *   2. Q2 — fill in `fallbackStrategy` for SINGLE delegate-sub-agent
 *      plans.
 *      - When the plan contains exactly ONE delegate-sub-agent step
 *        AND that step has no fallback, set fallback = 'llm-reasoning'.
 *        This is the conservative shape the brief specifies: a single
 *        specialist that fails can degrade to a generic LLM answer
 *        attempt rather than going straight to the gate.
 *      - Multi-delegate plans (the "3 agents debate" shape) DO NOT get
 *        auto-fallback. Collapsing every specialist into one llm-reasoning
 *        rung would erase the diversity the user asked for, and the
 *        partial-failure decision gate is the right rung for those.
 *      - Steps that already have an explicit fallback are preserved
 *        verbatim — `fallbackOrigin` defaults to 'planner' so audit
 *        events can tell apart "planner thought ahead" from "Vinyan's
 *        normalizer kicked in".
 *      - Non-delegate strategies are LEFT ALONE. The brief explicitly
 *        scopes the auto-fallback to delegate-sub-agent.
 *
 * Why the normalizer is deterministic and visible (vs in the executor):
 *   - A3 reproducibility: dump the plan to JSON and the executor's
 *     verdict on retry/fallback is fully derivable from that JSON.
 *   - A8 provenance: the plan is what gets persisted; an explicit
 *     `fallbackOrigin: 'auto-normalizer'` makes auto-fallback visible
 *     to dashboards and audit replay.
 */
import type { WorkflowPlan, WorkflowStep, WorkflowStepStrategy } from './types.ts';
import { DEFAULT_DELEGATE_RETRY_BUDGET, MAX_STEP_RETRY_BUDGET } from './types.ts';

/**
 * Conservative auto-fallback strategy. `llm-reasoning` is chosen over
 * `full-pipeline` because:
 *
 *   - It is purely generative — no tool execution, no file writes — so
 *     a delegate-sub-agent that failed for transient reasons can still
 *     produce *some* answer without stepping into untrusted territory.
 *   - `full-pipeline` would invoke the orchestrator recursively, which
 *     for a single failed delegate is overkill and adds budget pressure.
 *   - It exists in every deployment (no provider-feature gating), so
 *     the normalizer never produces a plan the executor cannot run.
 */
const DEFAULT_DELEGATE_FALLBACK: WorkflowStepStrategy = 'llm-reasoning';

/**
 * Strategies that are valid as `fallbackStrategy` for a delegate step.
 * Used to reject planner-emitted fallbacks that loop back into the same
 * strategy or land on a strategy that can't run without delegate-only
 * dependencies (e.g. `external-coding-cli` requires a CLI strategy
 * adapter that delegate dispatch doesn't share).
 */
const DELEGATE_FALLBACK_ALLOWED: ReadonlySet<WorkflowStepStrategy> = new Set<WorkflowStepStrategy>([
  'llm-reasoning',
  'knowledge-query',
  'full-pipeline',
]);

/**
 * Normalize a parsed workflow plan in place — returns a new plan with
 * the same shape so callers don't need to mutate. Idempotent: running
 * the normalizer twice produces the same output as running it once.
 */
export function normalizeWorkflowPlan(plan: WorkflowPlan): WorkflowPlan {
  const delegateSteps = plan.steps.filter((s) => s.strategy === 'delegate-sub-agent');
  const isSingleDelegatePlan = delegateSteps.length === 1;

  const steps: WorkflowStep[] = plan.steps.map((step) => {
    const out: WorkflowStep = { ...step };

    // Q1 — retry budget normalization. Defaults applied here so the
    // executor's `resolveStepRetryBudget` and the persisted plan agree.
    out.retryBudget = clampRetryBudget(step);

    // Q2 — fallback normalization. Only inspect delegate-sub-agent
    // steps; other strategies are left untouched.
    if (step.strategy === 'delegate-sub-agent') {
      const explicit = normalizeExplicitFallback(step.fallbackStrategy);
      if (explicit) {
        // Planner emitted a valid fallback — preserve it and stamp the
        // origin so audit replay can tell apart planner-emitted from
        // auto-added.
        out.fallbackStrategy = explicit;
        out.fallbackOrigin = step.fallbackOrigin ?? 'planner';
      } else if (step.fallbackStrategy && !explicit) {
        // Planner emitted an INVALID fallback (e.g. recursive
        // delegate-sub-agent or human-input). Drop it — multi-delegate
        // plans below would skip auto-fallback, so we don't replace
        // with an auto value blindly. Single-delegate plans fall
        // through to the auto-add branch.
        delete out.fallbackStrategy;
        delete out.fallbackOrigin;
      }

      const stillMissing = !out.fallbackStrategy;
      if (stillMissing && isSingleDelegatePlan) {
        out.fallbackStrategy = DEFAULT_DELEGATE_FALLBACK;
        out.fallbackOrigin = 'auto-normalizer';
      }
    }

    return out;
  });

  return { ...plan, steps };
}

/**
 * Clamp a step's retry budget into the allowed range and apply the
 * delegate-sub-agent default. Mirrors the runtime resolver in the
 * executor so the persisted plan and the runtime verdict agree.
 */
function clampRetryBudget(step: WorkflowStep): number {
  const raw = step.retryBudget;
  const max = MAX_STEP_RETRY_BUDGET;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return step.strategy === 'delegate-sub-agent' ? DEFAULT_DELEGATE_RETRY_BUDGET : 0;
  }
  if (raw < 0) return 0;
  if (raw > max) return max;
  return Math.floor(raw);
}

/**
 * Validate an explicit fallback emitted by the planner. Returns the
 * strategy when it is allowed for delegate fallback, otherwise
 * undefined so the caller can drop / replace it.
 *
 * Hard rejections:
 *   - `delegate-sub-agent` itself — recursive delegate-of-a-delegate
 *     is the planner re-asking the same question. The retry loop is
 *     where same-strategy reattempts belong.
 *   - `human-input` — fallback should not be a user-blocking step.
 *     If the workflow needs human input on failure, the existing
 *     partial-failure decision gate is the right rung.
 *   - `direct-tool` — a tool execution as fallback to a generative
 *     step is a strategy mismatch the executor does not validate
 *     elsewhere; keep the conservative allowlist.
 *   - `external-coding-cli` — requires a CLI strategy adapter and
 *     non-trivial input shape; not a safe drop-in for a failed
 *     delegate-sub-agent.
 */
function normalizeExplicitFallback(
  fallback: WorkflowStepStrategy | undefined,
): WorkflowStepStrategy | undefined {
  if (!fallback) return undefined;
  if (!DELEGATE_FALLBACK_ALLOWED.has(fallback)) return undefined;
  return fallback;
}
