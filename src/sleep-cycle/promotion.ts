/**
 * M4 — Sleep-cycle promotion of patterns into commonsense rules.
 *
 * Standalone function — `SleepCycleRunner` can call into it after pattern
 * mining completes, but tests can also exercise it directly. Wires four
 * gates:
 *
 *   1. Eligibility:  pattern.type ∈ {anti-pattern, success-pattern}
 *   2. Wilson LB:    pattern.confidence ≥ wilsonThreshold (default 0.95)
 *   3. Sample size:  pattern.frequency ≥ minObservations (default 30)
 *   4. Walk-forward: pattern's signal holds in ≥ K-1 of K time windows
 *      (default 4 of 5) — replaces the v1 design's 80/20 split per
 *      research-driven findings ([Lightly walk-forward](https://www.lightly.ai/blog/train-test-validation-split)).
 *
 * On promotion: maps pattern → CommonSenseRule via `inferMicrotheory` +
 * `inferRuleMatcher`, marks `source: 'promoted-from-pattern'`, and inserts
 * via `CommonSenseRegistry.insertRule()` (which clamps priority to [30, 70]
 * for promoted-from-pattern source — see registry.ts:PRIORITY_CAPS).
 *
 * No LLM — A3 deterministic governance: rule generation from observed
 * patterns, applied via fixed thresholds + content-addressed insertion.
 *
 * See `docs/design/commonsense-substrate-system-design.md` §6 (M4).
 */
import { wilsonLowerBound } from './wilson.ts';
import { inferMicrotheory, inferRuleMatcher } from '../oracle/commonsense/microtheory-inferer.ts';
import type { CommonSenseRegistry } from '../oracle/commonsense/registry.ts';
import type { CommonSenseRule, DefaultOutcome } from '../oracle/commonsense/types.ts';
import type { ExecutionTrace, ExtractedPattern } from '../orchestrator/types.ts';

// ── Public types ─────────────────────────────────────────────────────────

export interface PromotionOptions {
  registry: CommonSenseRegistry;
  /** Historical traces for walk-forward backtest. */
  traces: ExecutionTrace[];
  /** Wilson LB threshold for promotion (default 0.95). */
  wilsonThreshold?: number;
  /** Minimum frequency / observations (default 30). */
  minObservations?: number;
  /** Walk-forward windows (default K=5). */
  walkForwardWindows?: number;
  /** Minimum windows that must pass (default K-1=4). */
  walkForwardPassThreshold?: number;
  /** Z-score for Wilson CI (default 1.96 = 95%). */
  wilsonZ?: number;
}

export interface PromotionResult {
  promoted: boolean;
  reason: string;
  rule?: CommonSenseRule;
  diagnostics: {
    wilsonLB: number;
    observationCount: number;
    walkForwardPassing?: number;
    walkForwardTotal?: number;
  };
}

// ── Walk-forward backtest ────────────────────────────────────────────────

/**
 * Walk-forward backtest: split matching traces into K time windows;
 * require the pattern's claim to hold in ≥ passThreshold of K windows.
 *
 * Window-level threshold uses raw proportion (not Wilson) because Wilson
 * is conservative at small sample sizes (e.g. Wilson LB of 4/4 successes
 * = 0.51 due to small-N pessimism, well below the 0.6 anti-pattern bar).
 * The pattern-level Wilson 0.95 gate (in `promotePatternToCommonsense`)
 * already provides statistical rigor on the aggregate; walk-forward checks
 * temporal *consistency* of the signal, not its magnitude.
 *
 *   - Anti-pattern claim: this approach FAILS. Window passes if the
 *     failure-rate ≥ 0.6 in that window AND ≥ 3 traces in window.
 *   - Success-pattern claim: this approach SUCCEEDS. Window passes if the
 *     success-rate ≥ 0.5 in that window AND ≥ 3 traces in window.
 *
 * Walk-forward replaces the v1 design's 80/20 random split — see design
 * doc Appendix B (research-driven walk-forward citations).
 */
export function walkForwardBacktest(
  pattern: ExtractedPattern,
  traces: ExecutionTrace[],
  k: number,
): { passingWindows: number; total: number } {
  // Filter to traces matching this pattern's task signature.
  const matching = traces.filter((t) => t.taskTypeSignature === pattern.taskTypeSignature);
  // Need ≥ 3 traces per window for the proportion check to be meaningful.
  const minPerWindow = 3;
  if (matching.length < k * minPerWindow) {
    return { passingWindows: 0, total: k };
  }

  const sorted = [...matching].sort((a, b) => a.timestamp - b.timestamp);
  const windowSize = Math.floor(sorted.length / k);
  let passing = 0;

  for (let i = 0; i < k; i++) {
    const window = sorted.slice(i * windowSize, (i + 1) * windowSize);
    if (window.length < minPerWindow) continue;

    const failures = window.filter((t) => t.outcome === 'failure' || t.outcome === 'timeout').length;
    const successes = window.length - failures;

    if (pattern.type === 'anti-pattern') {
      const failureRate = failures / window.length;
      if (failureRate >= 0.6) passing++;
    } else {
      const successRate = successes / window.length;
      if (successRate >= 0.5) passing++;
    }
  }

  return { passingWindows: passing, total: k };
}

// ── Promotion ────────────────────────────────────────────────────────────

/**
 * Attempt to promote a single pattern into a commonsense rule. Returns a
 * structured `PromotionResult` describing the decision. Idempotent: same
 * pattern → same content-addressed rule id (via `computeRuleId`); registry
 * insert is `INSERT OR REPLACE`.
 */
export function promotePatternToCommonsense(
  pattern: ExtractedPattern,
  options: PromotionOptions,
): PromotionResult {
  const wilsonThreshold = options.wilsonThreshold ?? 0.95;
  const minObservations = options.minObservations ?? 30;
  const k = options.walkForwardWindows ?? 5;
  const passThreshold = options.walkForwardPassThreshold ?? 4;
  const z = options.wilsonZ ?? 1.96;

  const baseDiag = {
    wilsonLB: pattern.confidence,
    observationCount: pattern.frequency,
  };

  // Gate 1: eligibility — only anti/success patterns map to commonsense rules.
  // worker-performance and decomposition-pattern have different lifecycles.
  if (pattern.type !== 'anti-pattern' && pattern.type !== 'success-pattern') {
    return {
      promoted: false,
      reason: `pattern type '${pattern.type}' is not eligible for commonsense promotion`,
      diagnostics: baseDiag,
    };
  }

  // Gate 2: minimum observations
  if (pattern.frequency < minObservations) {
    return {
      promoted: false,
      reason: `frequency ${pattern.frequency} < ${minObservations}`,
      diagnostics: baseDiag,
    };
  }

  // Gate 3: Wilson LB threshold
  if (pattern.confidence < wilsonThreshold) {
    return {
      promoted: false,
      reason: `Wilson LB ${pattern.confidence.toFixed(3)} < ${wilsonThreshold}`,
      diagnostics: baseDiag,
    };
  }

  // Gate 4: walk-forward backtest
  void z; // wilsonZ retained for API compatibility; walk-forward uses raw proportion at window level
  const wf = walkForwardBacktest(pattern, options.traces, k);
  if (wf.passingWindows < passThreshold) {
    return {
      promoted: false,
      reason: `walk-forward ${wf.passingWindows}/${wf.total} passing < ${passThreshold}/${k}`,
      diagnostics: { ...baseDiag, walkForwardPassing: wf.passingWindows, walkForwardTotal: wf.total },
    };
  }

  // Gate 5: rule matcher must be inferable from approach
  const matcher = inferRuleMatcher(pattern);
  if (!matcher) {
    return {
      promoted: false,
      reason: "pattern.approach is empty or too short — no matcher inferable",
      diagnostics: { ...baseDiag, walkForwardPassing: wf.passingWindows, walkForwardTotal: wf.total },
    };
  }

  // ── Generate rule ────────────────────────────────────────────────────
  const microtheory = inferMicrotheory(pattern);
  const defaultOutcome: DefaultOutcome =
    pattern.type === 'anti-pattern' ? 'escalate' : 'allow';

  // Confidence: clamp to pragmatic band [0.5, 0.7].
  const confidence = clampToPragmatic(pattern.confidence);

  // Priority derived from Wilson LB: thresholdLB→50, max→70.
  // wilsonThreshold (0.95) maps to priority 50; 1.0 maps to 70.
  const priorityScore = 50 + (pattern.confidence - wilsonThreshold) * 400;
  const priority = Math.min(70, Math.max(30, Math.round(priorityScore)));

  const rule = options.registry.insertRule({
    microtheory,
    pattern: matcher,
    default_outcome: defaultOutcome,
    priority,
    confidence,
    source: 'promoted-from-pattern',
    rationale:
      `Promoted from pattern ${pattern.id} (${pattern.type}): ${pattern.description}` +
      (pattern.approach ? ` — approach: ${pattern.approach.slice(0, 80)}` : ''),
    promoted_from_pattern_id: pattern.id,
  });

  return {
    promoted: true,
    reason: 'promoted',
    rule,
    diagnostics: {
      ...baseDiag,
      walkForwardPassing: wf.passingWindows,
      walkForwardTotal: wf.total,
    },
  };
}

/**
 * Promote a batch of patterns. Returns per-pattern results so callers
 * (sleep-cycle runner, audit dashboards) can record metrics.
 */
export function promoteAllPatterns(
  patterns: ExtractedPattern[],
  options: PromotionOptions,
): PromotionResult[] {
  return patterns.map((p) => promotePatternToCommonsense(p, options));
}

function clampToPragmatic(c: number): number {
  if (c < 0.5) return 0.5;
  if (c > 0.7) return 0.7;
  return c;
}
