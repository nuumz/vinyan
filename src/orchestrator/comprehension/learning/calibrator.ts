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
  /** Total records with an outcome (the denominator of rawAccuracy). */
  sampleSize: number;
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
    private readonly loader: { recentByEngine: (engineId: string, limit?: number) => ComprehensionRecordRow[] },
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
  getEngineAccuracy(engineId: string): EngineAccuracy {
    const rows = this.loader.recentByEngine(engineId, this.sampleWindow);
    const sampleSize = rows.length;
    if (sampleSize === 0) {
      return {
        engineId,
        ema: null,
        rawAccuracy: null,
        sampleSize: 0,
        wilson95: null,
        insufficient: true,
        computedAt: this.now(),
      };
    }

    let positives = 0;
    for (const r of rows) {
      if (r.outcome && OUTCOME_IS_CORRECT[r.outcome] === 1) positives++;
    }
    const rawAccuracy = positives / sampleSize;

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
      sampleSize,
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
  detectDivergence(engineId: string, opts: DivergenceOptions = {}): DivergenceSignal | null {
    const recentWindow = opts.recentWindow ?? DEFAULT_DIVERGENCE_RECENT;
    const threshold = opts.deltaThreshold ?? DEFAULT_DIVERGENCE_DELTA;
    const minHistorical = opts.minSamplesPerWindow ?? DATA_GATE_MIN;

    const all = this.loader.recentByEngine(engineId, this.sampleWindow);
    // Require enough samples for a full recent window PLUS a statistically
    // meaningful historical window. The recent window need not equal
    // minHistorical — recent is for freshness, historical is for stability.
    if (all.length < recentWindow + minHistorical) return null;

    const recent = all.slice(0, recentWindow);
    const historical = all.slice(recentWindow);
    // Only the historical window must meet the min-samples gate; the recent
    // window size is bounded by `recentWindow` by construction.
    if (historical.length < minHistorical) return null;

    const rate = (rows: ComprehensionRecordRow[]): number => {
      let pos = 0;
      for (const r of rows) {
        if (r.outcome && OUTCOME_IS_CORRECT[r.outcome] === 1) pos++;
      }
      return pos / rows.length;
    };

    const recentAccuracy = rate(recent);
    const historicalAccuracy = rate(historical);
    const delta = recentAccuracy - historicalAccuracy;
    return {
      engineId,
      recentAccuracy,
      recentSamples: recent.length,
      historicalAccuracy,
      historicalSamples: historical.length,
      delta,
      diverged: -delta >= threshold,
      computedAt: this.now(),
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
  confidenceCeiling(engineId: string): ConfidenceCeiling {
    const acc = this.getEngineAccuracy(engineId);
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
