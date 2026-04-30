/**
 * Deterministic wait-vs-fallback policy for provider quota / rate-limit
 * failures. Pure function over the normalized error + budget — Axiom A3.
 *
 * The call site that catches an `LLMProviderError` does not implement its own
 * retry strategy. It asks `decidePolicyAction(...)` and acts on the verdict.
 * That keeps every governed code path consistent: the same 35s upstream wait
 * either always falls back or always sits, never sometimes one and sometimes
 * the other depending on which file caught the error.
 *
 * Why so few branches? "Wait once for a small upstream window if budget
 * absorbs it; otherwise jump tiers; otherwise fail honestly." That sentence
 * is the whole rule — implement it in code rather than leaving each caller to
 * reinvent it.
 */

import type { NormalizedLLMProviderError } from './provider-errors.ts';

/** Anything past this RetryAfter and we never wait — fall back instead. */
export const POLICY_WAIT_THRESHOLD_MS = 4_000;
/** Refuse to wait when fewer ms remain in the task budget than this. */
export const POLICY_BUDGET_FLOOR_MS = 5_000;

export interface PolicyContext {
  /** Remaining task budget in ms. Pass `Infinity` when unbounded (rare). */
  remainingBudgetMs: number;
  /** Whether the registry has another provider available for this task. */
  hasFallback: boolean;
  /** Number of times this task already tried this provider this turn. */
  attemptIndex: number;
}

export type PolicyDecision =
  | { action: 'wait'; waitMs: number; rationale: string }
  | { action: 'fallback'; rationale: string }
  | { action: 'fail'; rationale: string };

export function decidePolicyAction(err: NormalizedLLMProviderError, ctx: PolicyContext): PolicyDecision {
  // Auth + context_too_large + unknown — never retry the same provider.
  if (!err.isRetryable) {
    if (ctx.hasFallback && err.isFallbackRecommended) {
      return { action: 'fallback', rationale: `non-retryable ${err.kind}; trying alternate provider` };
    }
    return { action: 'fail', rationale: `non-retryable ${err.kind}; no fallback available` };
  }

  // We already tried once on this provider — never tight-loop the same one.
  if (ctx.attemptIndex >= 1) {
    if (ctx.hasFallback) {
      return { action: 'fallback', rationale: `same provider already retried (${err.kind})` };
    }
    // Without a fallback, only wait if the upstream actually told us how
    // long and the budget can absorb it. Otherwise fail — repeating without
    // information is the retry-storm we're guarding against.
    if (canWait(err, ctx)) {
      return { action: 'wait', waitMs: err.retryAfterMs!, rationale: 'no fallback; honoring upstream retry-after' };
    }
    return { action: 'fail', rationale: 'no fallback and budget cannot absorb retry-after' };
  }

  // First failure on this provider, this turn.
  if (err.isFallbackRecommended && ctx.hasFallback) {
    // Big retry-after → fall back; small one → wait once.
    if (canWait(err, ctx) && err.retryAfterMs! <= POLICY_WAIT_THRESHOLD_MS) {
      return {
        action: 'wait',
        waitMs: err.retryAfterMs!,
        rationale: `short retry-after (${err.retryAfterMs}ms) within budget`,
      };
    }
    return { action: 'fallback', rationale: 'fallback available; upstream wait too long or unspecified' };
  }

  if (canWait(err, ctx)) {
    return { action: 'wait', waitMs: err.retryAfterMs!, rationale: 'transient error within budget' };
  }
  return { action: 'fail', rationale: `${err.kind} and no safe wait window` };
}

function canWait(err: NormalizedLLMProviderError, ctx: PolicyContext): boolean {
  if (err.retryAfterMs === undefined) return false;
  if (err.retryAfterMs > POLICY_WAIT_THRESHOLD_MS) return false;
  return ctx.remainingBudgetMs - err.retryAfterMs >= POLICY_BUDGET_FLOOR_MS;
}

