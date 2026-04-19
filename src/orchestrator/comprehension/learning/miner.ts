/**
 * ComprehensionMiner — Sleep Cycle pattern extraction for the
 * comprehension substrate.
 *
 * This is the observe→analyze half of A7 (Prediction Error as Learning)
 * applied to the comprehension pipeline. Whereas the live-path
 * Calibrator feeds back per-engine accuracy per turn, the miner runs
 * offline on a batch of outcomed records and emits higher-order
 * insights the per-turn view cannot see:
 *
 *   B1 — Engine-fit by type + label-drift alarm
 *        Per (engine_id, engine_type), compute accuracy, Wilson LB,
 *        weighted accuracy, and a paired divergence signal. Fed to
 *        operator dashboards and the ceiling policy.
 *
 *   B2 — Correction-cascade candidates
 *        For each inputHash with BOTH a stage-1 (rule) and stage-2
 *        (llm) record, measure agreement on the final outcome. A high
 *        disagreement rate means the merge policy is choosing the
 *        wrong engine too often — a rule-promotion candidate.
 *
 *   B3 — Divergence attribution
 *        When an engine's `detectDivergence` signal fires, attach a
 *        small attribution block: recent-sample count, label-weight
 *        shift, and a per-session rollup so operators can see WHERE
 *        the regression is concentrated.
 *
 * Design constraints:
 *   - Pure functions over store rows + calibrator API. No mutations.
 *   - Cheap — one pass over the window; no extra DB round-trips per row.
 *   - A3 (Deterministic Governance): rule-based. No LLM in the miner.
 *   - A5 (Tiered Trust): insights carry their own tier (heuristic) —
 *     downstream consumers decide how to act.
 *   - Best-effort: a mining failure MUST NOT block the Sleep Cycle.
 *     Caller wraps in try/catch.
 */

import type { ComprehensionRecordRow, ComprehensionStore } from '../../../db/comprehension-store.ts';
import type { ComprehensionEngineType } from '../types.ts';
import {
  type ComprehensionCalibrator,
  DATA_GATE_MIN,
  type DivergenceSignal,
  wilson95,
} from './calibrator.ts';

/** How far back to read by default — 7 days. Adjustable per call. */
export const DEFAULT_MINING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Safety cap on rows loaded per mine() call. */
export const DEFAULT_MINING_ROW_CAP = 2000;
/**
 * Minimum pair count before B2 emits a correction-cascade insight.
 * Below this, the disagreement rate is too noisy to act on.
 */
export const DEFAULT_MIN_PAIRS = 10;

/**
 * An engine-fit summary for a single (engineId, engineType). Produced
 * by B1; one entry per engine seen in the window.
 */
export interface EngineFitInsight {
  readonly kind: 'engine-fit';
  readonly engineId: string;
  readonly engineType: ComprehensionEngineType | null;
  readonly sampleSize: number;
  readonly rawAccuracy: number | null;
  readonly weightedAccuracy: number | null;
  readonly wilsonLB: number | null;
  readonly insufficient: boolean;
  /** Paired label-drift alarm when present (AXM#3). */
  readonly divergence: DivergenceSignal | null;
}

/**
 * Stage-1 vs stage-2 agreement across the window. Produced by B2. A
 * low agreement rate indicates the hybrid pipeline's merge policy is
 * mis-attributing authority — promising signal for a rule-promoter.
 */
export interface CorrectionCascadeInsight {
  readonly kind: 'correction-cascade';
  /** Total turns where BOTH stages persisted a record. */
  readonly pairedTurns: number;
  /** Turns where stage-1 and stage-2 outcomes agreed. */
  readonly agreed: number;
  /** pairedTurns → agreementRate (agreed / pairedTurns). */
  readonly agreementRate: number;
  /**
   * Turns where stage-2 (LLM) was CONFIRMED but stage-1 (rule) was NOT
   * — i.e. moments where the LLM saw a nuance the rule missed.
   */
  readonly llmCorrectRuleWrong: number;
  /**
   * Turns where stage-1 (rule) was CONFIRMED but stage-2 (LLM) was NOT
   * — i.e. moments where the LLM over-confidently misread a simple
   * case. A high count here is a flag against loosening the ceiling.
   */
  readonly ruleCorrectLlmWrong: number;
  readonly insufficient: boolean;
}

/**
 * Divergence attribution — when B1's alarm fires, this attaches the
 * "where is the regression concentrated?" context. Produced by B3 only
 * when a divergence signal exists.
 */
export interface DivergenceAttributionInsight {
  readonly kind: 'divergence-attribution';
  readonly engineId: string;
  readonly engineType: ComprehensionEngineType | null;
  readonly recentSamples: number;
  readonly recentAccuracy: number;
  readonly historicalAccuracy: number;
  readonly delta: number;
  /** Recent window's mean label weight (null when no weights available). */
  readonly recentMeanLabelWeight: number | null;
  /** Historical window's mean label weight (null when no weights available). */
  readonly historicalMeanLabelWeight: number | null;
  /**
   * Per-session rollup: top-3 sessions contributing the most
   * `corrected`/`abandoned` outcomes in the recent window. Empty when
   * no recent records carry a session_id.
   */
  readonly topSessions: ReadonlyArray<{
    readonly sessionId: string;
    readonly negCount: number;
    readonly total: number;
  }>;
}

export type ComprehensionInsight =
  | EngineFitInsight
  | CorrectionCascadeInsight
  | DivergenceAttributionInsight;

export interface MiningResult {
  readonly minedAt: number;
  readonly windowSinceMs: number;
  readonly rowsScanned: number;
  readonly insights: ReadonlyArray<ComprehensionInsight>;
}

export interface MinerOptions {
  /** Window lookback in ms. */
  windowMs?: number;
  /** Max rows loaded per run. */
  rowCap?: number;
  /** Min paired turns before B2 fires. */
  minPairs?: number;
  /** Clock for testing. */
  now?: () => number;
}

/** Read-side deps; the store + calibrator interfaces are enough. */
export interface MinerDeps {
  readonly store: Pick<ComprehensionStore, 'outcomedInWindow'>;
  readonly calibrator: Pick<
    ComprehensionCalibrator,
    'getEngineAccuracy' | 'detectDivergence'
  >;
}

/**
 * Run one mining pass over the store's recent outcomed records.
 * Pure function: same input → same output modulo `now()`.
 */
export function mineComprehension(
  deps: MinerDeps,
  opts: MinerOptions = {},
): MiningResult {
  const now = opts.now ?? Date.now;
  const windowMs = opts.windowMs ?? DEFAULT_MINING_WINDOW_MS;
  const rowCap = opts.rowCap ?? DEFAULT_MINING_ROW_CAP;
  const minPairs = opts.minPairs ?? DEFAULT_MIN_PAIRS;
  const since = now() - windowMs;

  const rows = deps.store.outcomedInWindow(since, rowCap);
  const insights: ComprehensionInsight[] = [];

  // ── B1 — engine-fit summaries + divergence ──────────────────────
  // Group rows by (engineId, engineType). engineType can be null for
  // pre-migration-030 rows; we treat null as its own bucket to avoid
  // mixing it with typed rows.
  const engineBuckets = new Map<string, { engineId: string; engineType: ComprehensionEngineType | null; rows: ComprehensionRecordRow[] }>();
  for (const r of rows) {
    const key = `${r.engine_id}|${r.engine_type ?? ''}`;
    let bucket = engineBuckets.get(key);
    if (!bucket) {
      bucket = {
        engineId: r.engine_id,
        engineType: (r.engine_type as ComprehensionEngineType | null) ?? null,
        rows: [],
      };
      engineBuckets.set(key, bucket);
    }
    bucket.rows.push(r);
  }

  for (const bucket of engineBuckets.values()) {
    const acc = deps.calibrator.getEngineAccuracy(
      bucket.engineId,
      bucket.engineType ?? undefined,
    );
    const divergence = deps.calibrator.detectDivergence(
      bucket.engineId,
      undefined,
      bucket.engineType ?? undefined,
    );
    insights.push({
      kind: 'engine-fit',
      engineId: bucket.engineId,
      engineType: bucket.engineType,
      sampleSize: acc.sampleSize,
      rawAccuracy: acc.rawAccuracy,
      weightedAccuracy: acc.weightedAccuracy,
      wilsonLB: acc.wilson95?.lower ?? null,
      insufficient: acc.insufficient,
      divergence,
    });

    // ── B3 — divergence attribution, only when alarm fires ───────
    if (divergence && divergence.diverged) {
      insights.push(buildAttribution(bucket.rows, bucket.engineId, bucket.engineType, divergence));
    }
  }

  // ── B2 — stage-1 vs stage-2 agreement ───────────────────────────
  // Group rows by inputHash; a paired turn is one with ≥1 row of each
  // engineType in {rule, llm}. Anything else is a non-pair (ignored).
  //
  // Coverage note: after the engine-scoped markOutcome fix (core-loop
  // passes priorRecord.engine_id), only the merge-winner engine gets a
  // user-tested outcome per hybrid turn; the loser row stays NULL and
  // is excluded from `outcomedInWindow`. B2's paired-turn count
  // therefore reflects only turns where BOTH engines were somehow
  // labeled — e.g. single-engine turns reclassified or pre-fix data.
  // The trade-off is intentional: correctness of calibration (A7) over
  // observability of merge choices. A future enhancement could track
  // "who owned resolvedGoal" at record time to restore B2's original
  // reach without reintroducing the cross-engine label bias.
  const byHash = new Map<string, ComprehensionRecordRow[]>();
  for (const r of rows) {
    const bucket = byHash.get(r.input_hash);
    if (bucket) bucket.push(r);
    else byHash.set(r.input_hash, [r]);
  }
  let pairedTurns = 0;
  let agreed = 0;
  let llmCorrectRuleWrong = 0;
  let ruleCorrectLlmWrong = 0;
  for (const group of byHash.values()) {
    const rule = group.find((r) => r.engine_type === 'rule');
    const llm = group.find((r) => r.engine_type === 'llm');
    if (!rule || !llm) continue;
    // Skip pairs where either row carries `abandoned` — 'abandoned'
    // means "never tested by a user response", not a confirm/correct
    // signal. Counting it as agreement inflates the rate; counting it
    // as disagreement falsely penalizes one side. Drop from the pair
    // count entirely so the ratio reflects only turns both engines
    // were actually tested on.
    if (rule.outcome === 'abandoned' || llm.outcome === 'abandoned') continue;
    pairedTurns++;
    const rConfirmed = rule.outcome === 'confirmed';
    const lConfirmed = llm.outcome === 'confirmed';
    if (rConfirmed === lConfirmed) agreed++;
    else if (lConfirmed && !rConfirmed) llmCorrectRuleWrong++;
    else if (rConfirmed && !lConfirmed) ruleCorrectLlmWrong++;
  }
  const insufficient = pairedTurns < minPairs;
  insights.push({
    kind: 'correction-cascade',
    pairedTurns,
    agreed,
    agreementRate: pairedTurns > 0 ? agreed / pairedTurns : 0,
    llmCorrectRuleWrong,
    ruleCorrectLlmWrong,
    insufficient,
  });

  return {
    minedAt: now(),
    windowSinceMs: since,
    rowsScanned: rows.length,
    insights,
  };
}

/**
 * Build the divergence attribution for a single engine bucket. Uses
 * the same recent/historical split as `detectDivergence` so the
 * attribution numbers line up with the signal that triggered it.
 */
function buildAttribution(
  allRows: ComprehensionRecordRow[],
  engineId: string,
  engineType: ComprehensionEngineType | null,
  signal: DivergenceSignal,
): DivergenceAttributionInsight {
  // `allRows` is in the miner's time-window order (descending, since
  // outcomedInWindow returns DESC). But `detectDivergence` reads from
  // the FULL per-engine window via the store, so the split ratios
  // match by count, not by exact rows. We approximate here on the
  // miner's window — good enough for attribution, not for gating.
  const recentN = signal.recentSamples;
  const recent = allRows.slice(0, Math.min(recentN, allRows.length));
  const historical = allRows.slice(recent.length);

  const meanWeight = (rows: ComprehensionRecordRow[]): number | null => {
    let sum = 0;
    let n = 0;
    for (const r of rows) {
      const w = extractLabelWeight(r.outcome_evidence);
      if (w != null) {
        sum += w;
        n++;
      }
    }
    return n > 0 ? sum / n : null;
  };

  const sessionAgg = new Map<string, { neg: number; total: number }>();
  for (const r of recent) {
    if (!r.session_id || !r.outcome) continue;
    const b = sessionAgg.get(r.session_id) ?? { neg: 0, total: 0 };
    b.total++;
    if (r.outcome !== 'confirmed') b.neg++;
    sessionAgg.set(r.session_id, b);
  }
  const topSessions = Array.from(sessionAgg.entries())
    .map(([sessionId, v]) => ({ sessionId, negCount: v.neg, total: v.total }))
    // Attribution only surfaces sessions that ACTUALLY contributed at
    // least one negative outcome — a zero-neg session is noise, not a
    // cause of divergence.
    .filter((s) => s.negCount > 0)
    .sort((a, b) => b.negCount - a.negCount)
    .slice(0, 3);

  return {
    kind: 'divergence-attribution',
    engineId,
    engineType,
    recentSamples: signal.recentSamples,
    recentAccuracy: signal.recentAccuracy,
    historicalAccuracy: signal.historicalAccuracy,
    delta: signal.delta,
    recentMeanLabelWeight: meanWeight(recent),
    historicalMeanLabelWeight: meanWeight(historical),
    topSessions,
  };
}

function extractLabelWeight(evidenceJson: string | null): number | null {
  if (!evidenceJson) return null;
  try {
    const parsed = JSON.parse(evidenceJson) as { confidence?: unknown };
    if (typeof parsed.confidence === 'number' && parsed.confidence >= 0 && parsed.confidence <= 1) {
      return parsed.confidence;
    }
  } catch {
    /* malformed — ignore */
  }
  return null;
}

/**
 * Small helper exported for the Sleep Cycle bus payload — keep the
 * public insight shape stable if the internals change.
 */
export const MINING_DATA_GATE_MIN = DATA_GATE_MIN;
// Re-export for consumers that want to reason about Wilson outputs.
export { wilson95 };
