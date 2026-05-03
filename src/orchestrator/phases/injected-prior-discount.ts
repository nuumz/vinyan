/**
 * Verifier-side injected-prior discount (A5 operationalization).
 *
 * Why: round N's `kind:'verdict'` confidence claims independence from
 * the generation it verifies. When that generation depended on
 * cot-injected reasoning from round N-1 (memory-as-evidence), the
 * verdict is conditional on round N-1's correctness. Without an
 * explicit downgrade the verdict trace is dishonest about its own
 * dependency depth.
 *
 * How to apply: at every emit site for `kind:'verdict'`, compute
 * `discountedConfidence = oracleConfidence * lookupInjectedPriorMultiplier(...)`.
 * Default multiplier 0.85 (registered as `verify.injected_prior_discount`,
 * tunable per A14). When no inject decision targets the current task,
 * the multiplier is 1.0 — verdict confidence unchanged.
 *
 * Axiom alignment:
 *   A1 — Pure read of decision rows already in the audit log; never
 *        consumes thought content. The verifier's view stays
 *        generation-blind even though it knows a dependency exists.
 *   A3 — Deterministic: same audit log → same multiplier. No LLM in
 *        the path; the multiplier is a registry-default constant.
 *   A5 — The point of the file: confidence trace records dependency.
 *   A8 — Every applied discount can be replayed from the audit log
 *        because the inject-decision row's `ruleId` is stable.
 *   A9 — Lookup failure (no event store, no parent id, exception)
 *        returns multiplier 1.0 — never fails the verify path.
 */

import type { TaskEventStore } from '../../db/task-event-store.ts';
import type { ParameterStore } from '../adaptive-params/parameter-store.ts';
import type { InjectDependencyRegistry } from './inject-dependency-registry.ts';

/**
 * Stable rule id stamped on every cot-injection decision row by
 * `collaboration-block.ts:emitCotInjectionDecision`. Discovery key
 * for cross-task verdict discount.
 */
export const COT_INJECT_RULE_ID = 'collab-cot-inject-v1';

/** Registry key for the discount multiplier (range 0..1). */
export const COT_INJECT_DISCOUNT_PARAM = 'verify.injected_prior_discount';

/** Module-level default — must match `parameter-registry.ts`. */
export const DEFAULT_INJECT_DISCOUNT = 0.85;

export interface LookupOpts {
  /** Current task being verified. */
  taskId: string;
  /** From `TaskInput.parentTaskId`. Required for the durable-log fallback path. */
  parentTaskId?: string;
  /**
   * In-memory registry of inject decisions. PRIMARY lookup path —
   * sidesteps the recorder buffer race when the inject decision and
   * the verdict happen in the same orchestrator run. Present when
   * `factory.ts` wired the registry; absent in test harnesses that
   * bypass the factory (those rely on the durable-log fallback).
   */
  injectDependencyRegistry?: InjectDependencyRegistry;
  /**
   * Durable-log fallback for cases where the in-memory registry was
   * not wired (e.g., a fresh orchestrator instance reading a prior
   * run's events) or detached early. Absent ⇒ skip the fallback.
   */
  taskEventStore?: TaskEventStore;
  /** Optional store for the tunable multiplier. Absent ⇒ DEFAULT_INJECT_DISCOUNT. */
  parameterStore?: ParameterStore;
  /**
   * Cap on events scanned in the durable-log fallback. The lookup
   * walks parent's persisted log filtered by `eventType === 'audit:entry'`;
   * in long-running parents with many child tasks this can grow.
   * Bound for predictable cost.
   */
  maxEventsScanned?: number;
}

export interface LookupResult {
  /**
   * Per-step multiplier in [0, 1]. Equals the registry default (or
   * the tuned `verify.injected_prior_discount` value) when an inject
   * is found; 1.0 otherwise. Apply as `confidence * multiplier^depth`
   * via `applyInjectedPriorDiscount`.
   */
  multiplier: number;
  /** True iff we found at least one inject-decision row targeting `taskId`. */
  injectFound: boolean;
  /** How many inject-decision rows we found at the immediate target (informational). */
  injectCount: number;
  /**
   * Dependency chain depth — registry path only. 0 ⇒ no chain (no
   * inject targets this task). 1 ⇒ this task depends on a round whose
   * own inject chain is empty. N ⇒ N rounds back. Capped by
   * `MAX_INJECT_CHAIN_DEPTH`. Durable-log fallback returns
   * `injectCount` itself as a conservative depth proxy because the
   * fallback path doesn't have the thought→taskId chain index.
   */
  depth: number;
}

/**
 * Look up cot-inject decision rows targeting the current `taskId` and
 * return the multiplier to apply to the verdict's confidence.
 *
 * Lookup order:
 *   1. In-memory `injectDependencyRegistry` (preferred — avoids the
 *      recorder buffer race; same-run inject + verdict path).
 *   2. Durable `taskEventStore.listForTask(parentTaskId)` (fallback
 *      for replays or paths that bypassed the registry wiring).
 *
 * Both paths are deterministic on inputs; only the timing window
 * differs. Determinism across both is preserved because both query
 * the same predicate (`ruleId === COT_INJECT_RULE_ID`, `subTaskId
 * === taskId`, `verdict.startsWith('cot-inject:')`).
 */
export function lookupInjectedPriorMultiplier(opts: LookupOpts): LookupResult {
  const noDiscount: LookupResult = {
    multiplier: 1,
    injectFound: false,
    injectCount: 0,
    depth: 0,
  };

  // Path 1 — in-memory registry. Synchronous, race-free, depth-aware.
  if (opts.injectDependencyRegistry) {
    const entries = opts.injectDependencyRegistry.lookup(opts.taskId);
    if (entries.length > 0) {
      const multiplier = readMultiplier(opts.parameterStore);
      const depth = opts.injectDependencyRegistry.computeDepth(opts.taskId);
      return { multiplier, injectFound: true, injectCount: entries.length, depth };
    }
  }

  // Path 2 — durable log fallback.
  if (!opts.parentTaskId || !opts.taskEventStore) return noDiscount;

  const limit = opts.maxEventsScanned ?? 500;
  let events: Array<{ eventType: string; payload: unknown }>;
  try {
    events = opts.taskEventStore.listForTask(opts.parentTaskId, { limit });
  } catch {
    // A9: a flaky read must not fail the verify path. No discount when
    // we cannot prove a dependency exists.
    return noDiscount;
  }

  let injectCount = 0;
  for (const ev of events) {
    if (ev.eventType !== 'audit:entry') continue;
    const p = (ev.payload ?? {}) as Record<string, unknown>;
    if (p.kind !== 'decision') continue;
    if (p.ruleId !== COT_INJECT_RULE_ID) continue;
    if (p.subTaskId !== opts.taskId) continue;
    const verdict = typeof p.verdict === 'string' ? p.verdict : '';
    if (!verdict.startsWith('cot-inject:')) continue;
    injectCount++;
  }
  if (injectCount === 0) return noDiscount;

  const multiplier = readMultiplier(opts.parameterStore);
  // Conservative depth = 1 in the fallback path. The durable log can
  // be walked further to compute true chain depth, but doing so on
  // every verify call would be O(N×M) without an index. The registry
  // path covers the common (same-run) case; cross-restart consumers
  // pay only the per-step discount.
  return { multiplier, injectFound: true, injectCount, depth: 1 };
}

/**
 * Apply the discount to a confidence number. The chain compounds:
 * `confidence * multiplier^depth`. Strict A5 reading: if round 2's
 * generation depended on round 1's reasoning which itself depended
 * on round 0, the verdict's confidence must reflect TWO layers of
 * heuristic dependency, not one.
 *
 * `depth === 0` ⇒ multiplier^0 = 1, confidence unchanged.
 * `depth >= 1` ⇒ confidence * multiplier^depth.
 *
 * Out-of-range inputs (NaN, negatives, >1) are passed through
 * unchanged — confidence sanitization is the verifier's responsibility,
 * not this helper's.
 */
export function applyInjectedPriorDiscount(confidence: number | undefined, result: LookupResult): number | undefined {
  if (confidence === undefined) return undefined;
  if (!Number.isFinite(confidence)) return confidence;
  if (!result.injectFound) return confidence;
  if (result.depth <= 0) return confidence;
  return confidence * result.multiplier ** result.depth;
}

function readMultiplier(store?: ParameterStore): number {
  if (!store) return DEFAULT_INJECT_DISCOUNT;
  try {
    const v = store.getNumber(COT_INJECT_DISCOUNT_PARAM);
    if (Number.isFinite(v) && v >= 0 && v <= 1) return v;
    return DEFAULT_INJECT_DISCOUNT;
  } catch {
    return DEFAULT_INJECT_DISCOUNT;
  }
}
