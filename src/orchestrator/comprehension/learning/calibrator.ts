/**
 * Comprehension Calibrator — per-engine EMA accuracy tracker with a
 * Wilson 95% confidence interval for sample-size honesty.
 *
 * Feeds on `ComprehensionStore.recentByEngine(engineId)` and exposes
 * `getEngineAccuracy(engineId)` for:
 *   1. The LLM comprehender data-gate (P2.C): clamp LLM confidence
 *      proportional to observed accuracy until sampleSize ≥ N.
 *   2. The oracle tier-clamp: engines with accuracy < threshold get
 *      tier clamped to `probabilistic`.
 *   3. Dashboards + traces for observability.
 *
 * Two knobs, both honest:
 *   - α (EMA weight) — higher = faster learning, noisier. Default 0.1.
 *   - DATA_GATE_MIN — sample size below which the calibrator refuses to
 *     produce a pointwise accuracy (returns `insufficient`). Prevents
 *     the "2 samples, 50% accuracy" trap.
 *
 * Pure function over the store's outputs — no side effects, no timers.
 * Callers can cache (recompute per turn is fast).
 */

import type { ComprehensionOutcome, ComprehensionRecordRow } from '../../../db/comprehension-store.ts';
import type { ComprehensionEngineType } from '../types.ts';

export const DEFAULT_EMA_ALPHA = 0.1;
export const DATA_GATE_MIN = 20;

/** Which outcomes count as "correct"? */
const OUTCOME_IS_CORRECT: Record<ComprehensionOutcome, number> = {
  confirmed: 1,
  corrected: 0,
  abandoned: 0,
};

export interface EngineAccuracy {
  engineId: string;
  /** EMA of outcome→{0,1}. Null when sampleSize < DATA_GATE_MIN. */
  ema: number | null;
  /** Raw pass/total ratio over the full sampled window (confirm / all). */
  rawAccuracy: number | null;
  /**
   * GAP#4 — weighted raw accuracy using `evidence.confidence` from
   * AXM#5's CorrectionDetector. A "continuation-default" (weight 0.5)
   * contributes half a sample; an "explicit-token" (weight 1.0)
   * contributes a full sample. Null when sampleSize < DATA_GATE_MIN
   * OR when no record carries a weight.
   *
   * Read this INSTEAD of `rawAccuracy` when label-uncertainty matters
   * (P2.C's tier-clamp, Sleep Cycle mining). Additive — existing
   * consumers keep using `rawAccuracy`.
   */
  weightedAccuracy: number | null;
  /** Total records with an outcome (the denominator of rawAccuracy). */
  sampleSize: number;
  /** Sum of label weights — the "effective" sample size for weightedAccuracy. */
  effectiveSampleSize: number;
  /** Wilson 95% CI on the raw pass rate. Null when sampleSize is 0. */
  wilson95: { lower: number; upper: number } | null;
  /**
   * True when sampleSize < DATA_GATE_MIN. Downstream code treats this
   * as "not yet callable" — LLM comprehender confidence should be
   * clamped conservatively, regardless of whatever raw ratio exists.
   */
  insufficient: boolean;
  /** Epoch ms of the computation (for cache freshness). */
  computedAt: number;
}

export interface CalibratorOptions {
  alpha?: number;
  /** Limit records scanned per engine. Must be ≥ DATA_GATE_MIN. */
  sampleWindow?: number;
  /** Clock for testing. */
  now?: () => number;
}

/**
 * GAP#4 — extract the CorrectionDetector's `evidence.confidence` from
 * the stored outcome_evidence JSON. Returns null when absent or
 * malformed — callers fall back to unit weight (1.0).
 */
function labelWeight(outcomeEvidenceJson: string | null): number | null {
  if (!outcomeEvidenceJson) return null;
  try {
    const parsed = JSON.parse(outcomeEvidenceJson) as { confidence?: unknown };
    if (typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1) {
      return parsed.confidence;
    }
  } catch {
    /* malformed JSON — ignore */
  }
  return null;
}

/**
 * Standalone Wilson score interval (no external dep).
 * Formula reference: Wilson, 1927; see `docs/spec/tdd.md` §21 for other
 * uses in the codebase.
 */
export function wilson95(positives: number, total: number): { lower: number; upper: number } | null {
  if (total <= 0) return null;
  const z = 1.96;
  const p = positives / total;
  const z2 = z * z;
  const denom = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denom;
  const margin = (z / denom) * Math.sqrt((p * (1 - p)) / total + z2 / (4 * total * total));
  return { lower: Math.max(0, center - margin), upper: Math.min(1, center + margin) };
}

/**
 * The calibrator itself. Stateless w.r.t. the DB — reads the store on
 * every `getEngineAccuracy` call. For hot paths that need to check
 * accuracy every turn, wrap in a 30-second TTL memoizer at the caller.
 */
export class ComprehensionCalibrator {
  private readonly alpha: number;
  private readonly sampleWindow: number;
  private readonly now: () => number;

  constructor(
    private readonly loader: {
      recentByEngine: (
        engineId: string,
        limit?: number,
        engineType?: ComprehensionEngineType,
      ) => ComprehensionRecordRow[];
    },
    opts: CalibratorOptions = {},
  ) {
    this.alpha = opts.alpha ?? DEFAULT_EMA_ALPHA;
    this.sampleWindow = Math.max(DATA_GATE_MIN, opts.sampleWindow ?? 200);
    this.now = opts.now ?? Date.now;
  }

  /**
   * Compute the current accuracy estimate for an engine. The store is
   * expected to return outcomes in DESCENDING time order; we fold them
   * in REVERSE so older samples weigh less under EMA (i.e. the EMA's
   * "current" value reflects recent performance more).
   */
  getEngineAccuracy(engineId: string, engineType?: ComprehensionEngineType): EngineAccuracy {
    const rows = this.loader.recentByEngine(engineId, this.sampleWindow, engineType);
    const sampleSize = rows.length;
    if (sampleSize === 0) {
      return {
        engineId,
        ema: null,
        rawAccuracy: null,
        weightedAccuracy: null,
        sampleSize: 0,
        effectiveSampleSize: 0,
        wilson95: null,
        insufficient: true,
        computedAt: this.now(),
      };
    }

    let positives = 0;
    // GAP#4 — weighted pass + denominator (AXM#5 label confidence).
    let weightedPositives = 0;
    let totalWeight = 0;
    let anyWeighted = false;
    for (const r of rows) {
      if (!r.outcome) continue;
      if (OUTCOME_IS_CORRECT[r.outcome] === 1) positives++;
      const w = labelWeight(r.outcome_evidence);
      if (w != null) anyWeighted = true;
      const effectiveW = w ?? 1;
      totalWeight += effectiveW;
      if (OUTCOME_IS_CORRECT[r.outcome] === 1) weightedPositives += effectiveW;
    }
    const rawAccuracy = positives / sampleSize;
    // weightedAccuracy null when no records carried a weight field (pre-
    // AXM#5 data) — consumer treats as "same as rawAccuracy" in that case.
    const weightedAccuracy =
      anyWeighted && totalWeight > 0 ? weightedPositives / totalWeight : null;

    // Fold oldest → newest so recent outcomes dominate the EMA.
    let ema = rawAccuracy; // seed with raw to avoid cold-start distortion
    for (let i = rows.length - 1; i >= 0; i--) {
      const outcome = rows[i]!.outcome;
      if (!outcome) continue; // shouldn't happen — recentByEngine filters — belt+suspenders
      const label = OUTCOME_IS_CORRECT[outcome];
      ema = this.alpha * label + (1 - this.alpha) * ema;
    }

    const insufficient = sampleSize < DATA_GATE_MIN;
    return {
      engineId,
      ema: insufficient ? null : ema,
      rawAccuracy,
      weightedAccuracy: insufficient ? null : weightedAccuracy,
      sampleSize,
      effectiveSampleSize: totalWeight,
      wilson95: wilson95(positives, sampleSize),
      insufficient,
      computedAt: this.now(),
    };
  }

  /**
   * AXM#3 — compare the engine's RECENT-window accuracy against its
   * HISTORICAL-window accuracy. Returns `null` when either window has
   * fewer than `minSamplesPerWindow` samples (no meaningful signal).
   * Otherwise emits a DivergenceSignal with `diverged = true` when the
   * historical minus recent gap exceeds `deltaThreshold`.
   *
   * Pure function over store.recentByEngine — safe to call on every
   * markOutcome. Caller emits the bus event when diverged=true.
   */
  detectDivergence(
    engineId: string,
    opts: DivergenceOptions = {},
    engineType?: ComprehensionEngineType,
  ): DivergenceSignal | null {
    const recentWindow = opts.recentWindow ?? DEFAULT_DIVERGENCE_RECENT;
    const threshold = opts.deltaThreshold ?? DEFAULT_DIVERGENCE_DELTA;
    const minHistorical = opts.minSamplesPerWindow ?? DATA_GATE_MIN;

    const all = this.loader.recentByEngine(engineId, this.sampleWindow, engineType);
    if (all.length < recentWindow + minHistorical) return null;

    const recent = all.slice(0, recentWindow);
    const historical = all.slice(recentWindow);
    if (historical.length < minHistorical) return null;

    const positives = (rows: ComprehensionRecordRow[]): number => {
      let pos = 0;
      for (const r of rows) {
        if (r.outcome && OUTCOME_IS_CORRECT[r.outcome] === 1) pos++;
      }
      return pos;
    };
    const rPos = positives(recent);
    const hPos = positives(historical);
    const recentAccuracy = rPos / recent.length;
    const historicalAccuracy = hPos / historical.length;
    const delta = recentAccuracy - historicalAccuracy;

    // AXM#8: CI-gated divergence. Don't cry wolf on 1-2 bad samples.
    // We require BOTH the raw delta to exceed threshold AND the Wilson
    // 95% CIs to actually separate (recent upper < historical lower).
    // This is the same statistical hygiene the rest of Vinyan applies
    // (Wilson LB ranking in WorkerSelector, etc.).
    const recentCI = wilson95(rPos, recent.length);
    const historicalCI = wilson95(hPos, historical.length);
    const deltaPassesThreshold = -delta >= threshold;
    const ciSeparates =
      recentCI != null && historicalCI != null && recentCI.upper < historicalCI.lower;
    const diverged = deltaPassesThreshold && ciSeparates;

    return {
      engineId,
      recentAccuracy,
      recentSamples: recent.length,
      historicalAccuracy,
      historicalSamples: historical.length,
      delta,
      diverged,
      computedAt: this.now(),
    };
  }

  /**
   * P3.A — EFFECTIVE ceiling: `confidenceCeiling` tightened by a
   * divergence penalty when the engine is currently degrading. This is
   * Vinyan's observe→respond half of A7: the ceiling GOVERNS future
   * output, and degradation AUTOMATICALLY tightens the governance.
   *
   * Computation:
   *   base = confidenceCeiling(engineId)
   *   if base is unknown → return unknown (no divergence math on no data)
   *   sig  = detectDivergence(engineId)
   *   if sig == null OR !sig.diverged → return base (no adjustment)
   *   else → penalty = recentAccuracy (the degraded rate).
   *         New ceiling = min(base.value, recentAccuracy)
   *         — we refuse to trust a degraded engine beyond its NEW rate.
   *
   * A5 conservative: `effectiveCeiling` is always ≤ `confidenceCeiling`.
   */
  effectiveCeiling(
    engineId: string,
    opts: DivergenceOptions = {},
    engineType?: ComprehensionEngineType,
  ): ConfidenceCeiling {
    const base = this.confidenceCeiling(engineId, engineType);
    if (base.kind === 'unknown') return base;
    const sig = this.detectDivergence(engineId, opts, engineType);
    if (!sig || !sig.diverged) return base;
    // AXM#6: use Wilson 95% LOWER bound on recent-window accuracy
    // instead of the raw point estimate. On small samples a point
    // estimate can over-tighten (e.g. 1 bad outcome in 10 → 0.9 cap);
    // Wilson LB is statistically honest about the sample-size
    // uncertainty. Same reasoning as WorkerSelector's Wilson ranking.
    const rPos = Math.round(sig.recentAccuracy * sig.recentSamples);
    const ci = wilson95(rPos, sig.recentSamples);
    const tighteningCap = ci != null ? ci.lower : sig.recentAccuracy;
    const tightened = Math.max(0, Math.min(base.value, tighteningCap));
    return { kind: 'known', value: tightened };
  }

  /**
   * AXM#7 — Brier score (mean squared prediction error) measures
   * calibration QUALITY, not just accuracy. A "confirmed" outcome with
   * confidence=0.9 scores 0.01; with confidence=0.3 it scores 0.49.
   * The accuracy metric treats both as "correct"; Brier distinguishes
   * well-calibrated from lucky.
   *
   * Lower = better. 0.0 = perfect calibration. 0.25 = coin flip. >0.25 = worse than random.
   *
   * Returns `insufficient` when fewer than DATA_GATE_MIN records — same
   * A2 honesty pattern as `confidenceCeiling`. Caller decides fallback.
   */
  brierScore(engineId: string, engineType?: ComprehensionEngineType): {
    readonly brier: number | null;
    /**
     * GAP#4 — weighted Brier using AXM#5 label confidence. Null when no
     * records carry a label weight. Weighted denominator reduces the
     * influence of low-confidence "continuation-default" labels on the
     * final score.
     */
    readonly weightedBrier: number | null;
    readonly sampleSize: number;
    readonly effectiveSampleSize: number;
    readonly insufficient: boolean;
  } {
    const rows = this.loader.recentByEngine(engineId, this.sampleWindow, engineType);
    const n = rows.length;
    if (n === 0) {
      return {
        brier: null,
        weightedBrier: null,
        sampleSize: 0,
        effectiveSampleSize: 0,
        insufficient: true,
      };
    }
    let sumSquaredError = 0;
    let weightedSumSquaredError = 0;
    let totalWeight = 0;
    let anyWeighted = false;
    let labeled = 0;
    for (const r of rows) {
      if (!r.outcome) continue;
      labeled++;
      const predicted = r.confidence;
      const actual = OUTCOME_IS_CORRECT[r.outcome];
      const diff = predicted - actual;
      const sq = diff * diff;
      sumSquaredError += sq;
      const w = labelWeight(r.outcome_evidence);
      if (w != null) anyWeighted = true;
      const effectiveW = w ?? 1;
      totalWeight += effectiveW;
      weightedSumSquaredError += effectiveW * sq;
    }
    const insufficient = n < DATA_GATE_MIN;
    const weighted =
      anyWeighted && totalWeight > 0 ? weightedSumSquaredError / totalWeight : null;
    return {
      brier: insufficient ? null : labeled > 0 ? sumSquaredError / labeled : null,
      weightedBrier: insufficient ? null : weighted,
      sampleSize: n,
      effectiveSampleSize: totalWeight,
      insufficient,
    };
  }

  /**
   * A2 (first-class uncertainty): ceiling is either a KNOWN value (data
   * exists and was sufficient) or an EXPLICIT UNKNOWN state. Downstream
   * consumers (e.g. P2.C's tier-clamp) MUST handle the `unknown` case
   * deliberately — conflating "no data yet" with "50% accurate" would
   * let a fresh engine masquerade as half-trusted. Callers decide the
   * fallback policy; the calibrator refuses to lie.
   */
  confidenceCeiling(engineId: string, engineType?: ComprehensionEngineType): ConfidenceCeiling {
    const acc = this.getEngineAccuracy(engineId, engineType);
    if (acc.sampleSize === 0) {
      return { kind: 'unknown', reason: 'engine-not-seen' };
    }
    if (acc.insufficient || acc.ema == null) {
      return { kind: 'unknown', reason: 'insufficient-data' };
    }
    return {
      kind: 'known',
      value: Math.max(0, Math.min(1, acc.ema)),
    };
  }
}

/**
 * Tagged return type for `confidenceCeiling`. See method doc.
 *   - `known`   → an EMA-backed point estimate is available.
 *   - `unknown` → data gate not yet met; caller must choose an explicit
 *                 fallback (e.g. clamp to 0.3 for LLM engines vs. 0.8 for
 *                 rule engines). Do NOT default to 0.5 silently.
 */
export type ConfidenceCeiling =
  | { readonly kind: 'known'; readonly value: number }
  | {
      readonly kind: 'unknown';
      readonly reason: 'insufficient-data' | 'engine-not-seen';
    };

/**
 * AXM#3 — signal emitted when an engine's RECENT-window accuracy has
 * dropped materially below its HISTORICAL-window accuracy. This is
 * Vinyan's early warning that an engine is degrading (model drift,
 * silent regression, poisoned calibration labels). Consumers include
 * the oracle tier-clamp (which can tighten the ceiling further) and
 * operator dashboards (for visibility).
 */
export interface DivergenceSignal {
  readonly engineId: string;
  /** Accuracy over the last `recentWindow` outcomes. */
  readonly recentAccuracy: number;
  readonly recentSamples: number;
  /** Accuracy over the full available sample (older window). */
  readonly historicalAccuracy: number;
  readonly historicalSamples: number;
  /** recentAccuracy − historicalAccuracy. Negative = degradation. */
  readonly delta: number;
  /** True when `-delta` exceeds the configured threshold. */
  readonly diverged: boolean;
  readonly computedAt: number;
}

export interface DivergenceOptions {
  /** Count of most-recent outcomes treated as the "recent" window. */
  recentWindow?: number;
  /**
   * Divergence threshold — trigger when `historicalAccuracy - recentAccuracy`
   * exceeds this amount. Default 0.2 (20% absolute drop). Lower = more
   * sensitive (more false positives); higher = slower to react.
   */
  deltaThreshold?: number;
  /**
   * Minimum samples each window must have for the comparison to be
   * meaningful. Default matches DATA_GATE_MIN to avoid noisy small-n
   * signals triggering the alarm prematurely.
   */
  minSamplesPerWindow?: number;
}

export const DEFAULT_DIVERGENCE_RECENT = 10;
export const DEFAULT_DIVERGENCE_DELTA = 0.2;
