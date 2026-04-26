/**
 * Adaptive thinking budget (G5 — interior LLM control).
 *
 * Tunes `ThinkingConfig.budgetTokens` (when extended thinking is enabled) and
 * the adaptive `effort` hint based on perception signals — type errors,
 * blast radius, test-coverage gap. Higher uncertainty → larger budget /
 * higher effort; trivial change → smaller budget so we don't burn extended
 * thinking on edits where it isn't needed.
 *
 * This is the heuristic baseline. When the Self-Model accumulates ≥100
 * traces (the data gate documented in the plan), `predict()` can return
 * calibrated multipliers that override the heuristic. Today we ship the
 * heuristic so the contract isn't dead until the gate clears.
 *
 * Pure function — no I/O, no LLM call. Lives in the deterministic governance
 * path under A3.
 *
 * Axioms: A7 (prediction error as learning signal — the multiplier is the
 * place to inject calibrated predictions later) + A3 (rule-based, not
 * probabilistic).
 */

import type { ThinkingConfig } from '../types.ts';

/** Perception signals consumed by the heuristic. All fields are optional. */
export interface AdaptivePerceptionSignals {
  /** Number of type errors at the time the routing decision was made. */
  typeErrorCount?: number;
  /** Files transitively affected by the change. */
  blastRadius?: number;
  /** 0..1 — fraction of target files covered by tests. Lower → riskier. */
  testCoverage?: number;
  /** 0..1 — average tier reliability of world-graph facts for target files. */
  avgTierReliability?: number;
  /** True when the task explicitly mutates code. */
  isMutation?: boolean;
}

export interface AdaptiveBudgetOptions {
  /** Lower clamp for the multiplier. Default 0.5. */
  minMultiplier?: number;
  /** Upper clamp for the multiplier. Default 2.0. */
  maxMultiplier?: number;
}

const DEFAULT_MIN = 0.5;
const DEFAULT_MAX = 2.0;

/**
 * Compute an uncertainty-driven multiplier for the thinking budget.
 *
 * Heuristic (additive, capped):
 *   - typeErrorCount ≥ 5  → +0.30
 *   - typeErrorCount ≥ 1  → +0.10
 *   - blastRadius ≥ 20    → +0.30
 *   - blastRadius ≥ 5     → +0.15
 *   - testCoverage < 0.3  → +0.20
 *   - avgTierReliability < 0.5 → +0.20  (low-confidence facts)
 *   - isMutation = false  → −0.20      (read-only tasks need less thinking)
 *
 * Final multiplier is clamped to [minMultiplier, maxMultiplier].
 */
export function computeAdaptiveMultiplier(
  signals: AdaptivePerceptionSignals,
  options: AdaptiveBudgetOptions = {},
): number {
  const minMul = options.minMultiplier ?? DEFAULT_MIN;
  const maxMul = options.maxMultiplier ?? DEFAULT_MAX;

  let m = 1.0;
  if (signals.typeErrorCount !== undefined) {
    if (signals.typeErrorCount >= 5) m += 0.3;
    else if (signals.typeErrorCount >= 1) m += 0.1;
  }
  if (signals.blastRadius !== undefined) {
    if (signals.blastRadius >= 20) m += 0.3;
    else if (signals.blastRadius >= 5) m += 0.15;
  }
  if (signals.testCoverage !== undefined && signals.testCoverage < 0.3) m += 0.2;
  if (signals.avgTierReliability !== undefined && signals.avgTierReliability < 0.5) m += 0.2;
  if (signals.isMutation === false) m -= 0.2;

  if (m < minMul) m = minMul;
  if (m > maxMul) m = maxMul;
  return m;
}

/**
 * Apply the adaptive multiplier to a `ThinkingConfig`.
 *
 * Returns either a NEW config (when the multiplier actually changes a field)
 * or the ORIGINAL `config` object unchanged (identity short-circuit when
 * `multiplier === 1`, or pass-through for `disabled` configs which the
 * heuristic deliberately doesn't enable). Callers that need to mutate the
 * result should `{ ...result }` it themselves; the function never mutates
 * the input.
 *
 * Behaviour by config type:
 *   - `enabled` (explicit budget) → budget multiplied + rounded.
 *   - `adaptive` (effort hint) → effort bumped UP one rung when
 *     `multiplier ≥ 1.5`, DOWN one rung when `≤ 0.7`, else unchanged
 *     (and the original object is returned in the unchanged case).
 *   - `disabled` → returned unchanged. Disabling thinking is an explicit
 *     operator decision that heuristics shouldn't override.
 */
export function applyAdaptiveThinkingBudget(config: ThinkingConfig, multiplier: number): ThinkingConfig {
  if (multiplier === 1) return config;
  if (config.type === 'enabled') {
    return { ...config, budgetTokens: Math.round(config.budgetTokens * multiplier) };
  }
  if (config.type === 'adaptive') {
    return { ...config, effort: bumpEffort(config.effort, multiplier) };
  }
  return config;
}

const EFFORT_LADDER = ['low', 'medium', 'high', 'max'] as const;
type Effort = (typeof EFFORT_LADDER)[number];

function bumpEffort(current: Effort, multiplier: number): Effort {
  const idx = EFFORT_LADDER.indexOf(current);
  if (idx < 0) return current;
  // multiplier > 1.5 → bump up by 1; multiplier < 0.7 → bump down by 1.
  let target = idx;
  if (multiplier >= 1.5) target = Math.min(EFFORT_LADDER.length - 1, idx + 1);
  else if (multiplier <= 0.7) target = Math.max(0, idx - 1);
  return EFFORT_LADDER[target] as Effort;
}
