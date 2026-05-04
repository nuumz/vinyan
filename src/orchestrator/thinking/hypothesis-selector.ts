/**
 * Yinyan T&R Kernel — L2 Hypothesis Selector.
 *
 * Picks a winner from N generated hypotheses using a pure, ordered rule
 * pipeline. A3 invariant: NO LLM CALL in this file. Every decision is a
 * deterministic function of (hypotheses, oracle verdicts, optional self-model
 * data) so the same inputs always produce the same `SelectionVerdict`.
 *
 * Rule pipeline (highest priority first — the first rule that yields a unique
 * survivor wins):
 *   1. Eliminate any hypothesis whose deterministic oracle pre-check failed (A5).
 *   2. Rank remaining by Wilson-LB success rate of (engineId, approachLabel)
 *      pulled from the optional history adapter.
 *   3. Tiebreak: lower token cost.
 *   4. Tiebreak: stable order — first hypothesis in the input slice wins.
 *
 * When the pipeline kills every candidate, the verdict is `type: 'abstain'`
 * (A2 first-class uncertainty). The kernel then degrades to the existing
 * single-shot path or escalates — it never invents a winner.
 */
import type { Hypothesis } from './hypothesis.ts';

/**
 * Optional per-hypothesis oracle verdict — supplied by the kernel after
 * running deterministic oracle pre-checks. Each verdict is independent of
 * the others (A1).
 *
 * `passed = false` is a HARD eliminator. The selector never re-weights a
 * failing oracle into a partial pass; that would dilute A5 (deterministic >
 * heuristic > probabilistic) by letting probabilistic Wilson-LB scores
 * resurrect a structurally-broken proposal.
 */
export interface PreCheckVerdict {
  hypothesisId: Hypothesis['id'];
  passed: boolean;
  oracle: string;
  /** Optional human-readable reason — surfaced in the SelectionVerdict trace. */
  reason?: string;
}

/**
 * Optional historical success-rate lookup. The kernel passes one of these
 * (or nothing for cold start) so the selector can rank survivors by tier 5
 * Wilson lower-bound — the same mechanic the existing pattern-mining
 * sleep-cycle uses for rule promotion. Cold-start callers omit it; the
 * selector then skips the Wilson rank and falls through to tiebreakers.
 */
export interface ApproachHistoryAdapter {
  /**
   * Return Wilson lower bound for (engineId, approachLabel) over the
   * caller's chosen window. Implementations MUST return a value in [0, 1]
   * and MUST return `undefined` when the (engineId, approachLabel) pair
   * has too few observations to compute a meaningful bound.
   */
  wilsonLowerBound(engineId: string, approachLabel: string): number | undefined;
}

/** The selector's verdict — replayable from inputs (A8). */
export type SelectionVerdict =
  | {
      type: 'select';
      winner: Hypothesis;
      runnerUp?: Hypothesis;
      /** Margin = wilsonLB(winner) - wilsonLB(runnerUp). Undefined when no history available. */
      margin?: number;
      /** Ordered rule trace — every rule that fired and its outcome. */
      rationale: string[];
      /** Eliminated hypotheses with the rule that killed each. */
      eliminations: Array<{ hypothesisId: Hypothesis['id']; rule: string; reason: string }>;
    }
  | {
      type: 'abstain';
      reason: string;
      eliminations: Array<{ hypothesisId: Hypothesis['id']; rule: string; reason: string }>;
    };

export interface SelectorInput {
  hypotheses: Hypothesis[];
  /** Pre-check verdicts keyed by hypothesisId. Missing entry = no pre-check ran (treated as pass). */
  preChecks?: PreCheckVerdict[];
  history?: ApproachHistoryAdapter;
}

/** Stateless selector. */
export interface HypothesisSelector {
  select(input: SelectorInput): SelectionVerdict;
}

type Elimination = SelectionVerdict['eliminations'][number];

export class DefaultHypothesisSelector implements HypothesisSelector {
  select(input: SelectorInput): SelectionVerdict {
    if (input.hypotheses.length === 0) {
      return { type: 'abstain', reason: 'no hypotheses provided', eliminations: [] };
    }
    const rationale: string[] = [];
    const eliminations: Elimination[] = [];

    let survivors = applyOraclePreCheck(input.hypotheses, input.preChecks ?? [], eliminations, rationale);
    survivors = applyTerminationFilter(survivors, eliminations, rationale);

    if (survivors.length === 0) {
      return {
        type: 'abstain',
        reason: 'all hypotheses eliminated by deterministic pre-checks',
        eliminations,
      };
    }
    if (survivors.length === 1) {
      const only = survivors[0];
      if (!only) return { type: 'abstain', reason: 'survivor invariant violated', eliminations };
      rationale.push('single survivor after eliminators');
      return { type: 'select', winner: only, rationale, eliminations };
    }

    const wilsonOutcome = applyWilsonRank(survivors, input.history, rationale);
    if (wilsonOutcome.kind === 'select') {
      return {
        type: 'select',
        winner: wilsonOutcome.winner,
        runnerUp: wilsonOutcome.runnerUp,
        margin: wilsonOutcome.margin,
        rationale,
        eliminations,
      };
    }
    survivors = wilsonOutcome.survivors;

    return finalizeWithTiebreakers(survivors, rationale, eliminations);
  }
}

// ── Stage helpers (extracted to keep `select` cognitive complexity ≤ 25) ─

function applyOraclePreCheck(
  hypotheses: Hypothesis[],
  preChecks: PreCheckVerdict[],
  eliminations: Elimination[],
  rationale: string[],
): Hypothesis[] {
  const failingByHyp = new Map<Hypothesis['id'], PreCheckVerdict>();
  for (const v of preChecks) if (!v.passed) failingByHyp.set(v.hypothesisId, v);
  const survivors = hypotheses.filter((h) => {
    const fail = failingByHyp.get(h.id);
    if (!fail) return true;
    eliminations.push({
      hypothesisId: h.id,
      rule: 'oracle-precheck',
      reason: `${fail.oracle} rejected${fail.reason ? `: ${fail.reason}` : ''}`,
    });
    return false;
  });
  if (survivors.length !== hypotheses.length) {
    rationale.push(`oracle-precheck eliminated ${hypotheses.length - survivors.length}`);
  }
  return survivors;
}

function applyTerminationFilter(
  hypotheses: Hypothesis[],
  eliminations: Elimination[],
  rationale: string[],
): Hypothesis[] {
  const survivors = hypotheses.filter((h) => {
    if (h.terminationReason !== 'limit_reached') return true;
    eliminations.push({
      hypothesisId: h.id,
      rule: 'termination-reason',
      reason: 'engine hit max-tokens — proposal incomplete',
    });
    return false;
  });
  if (survivors.length !== hypotheses.length) {
    rationale.push(`termination-reason eliminated ${hypotheses.length - survivors.length}`);
  }
  return survivors;
}

type WilsonOutcome =
  | { kind: 'select'; winner: Hypothesis; runnerUp?: Hypothesis; margin?: number }
  | { kind: 'tie'; survivors: Hypothesis[] };

function applyWilsonRank(
  survivors: Hypothesis[],
  history: ApproachHistoryAdapter | undefined,
  rationale: string[],
): WilsonOutcome {
  type Scored = { h: Hypothesis; wilson: number | undefined; ord: number };
  const scored: Scored[] = survivors.map((h, i) => ({
    h,
    wilson: history?.wilsonLowerBound(h.engineId, h.approachLabel),
    ord: i,
  }));
  if (!scored.some((s) => s.wilson !== undefined)) return { kind: 'tie', survivors };
  // Pure-function sort: by wilson desc, treating `undefined` as -Infinity
  // so unobserved branches never beat an observed positive one. We carry
  // input ord for stability — Array#sort is not stable across all runtimes.
  scored.sort((a, b) => {
    const aw = a.wilson ?? -Infinity;
    const bw = b.wilson ?? -Infinity;
    if (aw !== bw) return bw - aw;
    return a.ord - b.ord;
  });
  const top = scored[0];
  const second = scored[1];
  if (!top) return { kind: 'tie', survivors };
  const topW = top.wilson ?? -Infinity;
  const secondW = second?.wilson ?? -Infinity;
  if (second === undefined || topW !== secondW) {
    rationale.push(
      `wilson-lb rank: winner=${top.wilson?.toFixed(3) ?? 'n/a'} > runnerUp=${second?.wilson?.toFixed(3) ?? 'n/a'}`,
    );
    const margin = top.wilson !== undefined && second?.wilson !== undefined ? top.wilson - second.wilson : undefined;
    return { kind: 'select', winner: top.h, runnerUp: second?.h, margin };
  }
  const tied = scored.filter((s) => (s.wilson ?? -Infinity) === topW).map((s) => s.h);
  rationale.push(`wilson-lb tied at ${topW.toFixed(3)} across ${tied.length} survivors`);
  return { kind: 'tie', survivors: tied };
}

function finalizeWithTiebreakers(
  survivors: Hypothesis[],
  rationale: string[],
  eliminations: Elimination[],
): SelectionVerdict {
  const costRanked = [...survivors].sort((a, b) => costOf(a) - costOf(b));
  const cheapest = costRanked[0];
  const next = costRanked[1];
  if (cheapest && next && costOf(cheapest) !== costOf(next)) {
    rationale.push(`cost tiebreaker: ${costOf(cheapest)} < ${costOf(next)}`);
    return { type: 'select', winner: cheapest, runnerUp: next, rationale, eliminations };
  }
  rationale.push('stable-order tiebreaker (first survivor)');
  const winnerStable = survivors[0];
  if (!winnerStable) return { type: 'abstain', reason: 'survivor invariant violated', eliminations };
  return { type: 'select', winner: winnerStable, runnerUp: survivors[1], rationale, eliminations };
}

function costOf(h: Hypothesis): number {
  return h.tokensUsed.input + h.tokensUsed.output + (h.tokensUsed.thinking ?? 0);
}
