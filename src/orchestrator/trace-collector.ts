/**
 * Trace Collector — records execution traces and invalidates World Graph on success.
 *
 * Supports optional SQLite persistence via TraceStore injection.
 * Without TraceStore: in-memory only (backward compatible, used in tests).
 * With TraceStore: dual-write to memory + SQLite for Phase 2 Sleep Cycle queries.
 *
 * Source of truth: spec/tdd.md §12B (Execution Traces), §16 (Core Loop Step 6: LEARN)
 */

import type { VinyanBus } from '../core/bus.ts';
import type { TraceStore } from '../db/trace-store.ts';
import { computeCost } from '../economy/cost-computer.ts';
import type { CostLedger } from '../economy/cost-ledger.ts';
import type { RateCardEntry } from '../economy/economy-config.ts';
import { resolveRateCard } from '../economy/rate-card.ts';
import { LEVEL_CONFIG } from '../gate/risk-router.ts';
import type { WorldGraph } from '../world-graph/world-graph.ts';
import type { TraceCollector } from './core-loop.ts';
import type { ExecutionTrace } from './types.ts';

export class TracePersistenceError extends Error {
  readonly trace: ExecutionTrace;
  override readonly cause: unknown;

  constructor(trace: ExecutionTrace, cause: unknown) {
    super(`Trace ${trace.id} failed durable persistence`);
    this.name = 'TracePersistenceError';
    this.trace = trace;
    this.cause = cause;
  }
}

export function isTracePersistenceError(error: unknown): error is TracePersistenceError {
  return error instanceof TracePersistenceError;
}

export class TraceCollectorImpl implements TraceCollector {
  private traces: ExecutionTrace[] = [];
  private worldGraph?: WorldGraph;
  private traceStore?: TraceStore;
  private costLedger?: CostLedger;
  private rateCards?: Record<string, RateCardEntry>;
  private bus?: VinyanBus;
  /**
   * In-flight delegation registry — `taskId → parentTaskId`. Populated
   * by `executeTaskCore` at entry from `input.parentTaskId`, cleared in
   * the finally. When a trace is recorded for one of these tasks and the
   * builder didn't set `parentTaskId` on its own, we fill it from the
   * registry. Centralising the lookup here means individual trace
   * construction sites (security-rejection, intent-clarify,
   * conversational-shortcircuit, full-pipeline workflow) don't each have
   * to remember the propagation.
   */
  private pendingParentTaskIds = new Map<string, string>();

  constructor(worldGraph?: WorldGraph, traceStore?: TraceStore, bus?: VinyanBus) {
    this.worldGraph = worldGraph;
    this.traceStore = traceStore;
    // Phase 0: bus is wired up-front (not lazily via setEconomyDeps) so
    // `thinking:policy-evaluated` events fire even when the economy ledger
    // is disabled. Tests and minimal configs rely on this.
    this.bus = bus;
  }

  /** Wire economy dependencies after construction (avoids circular deps). */
  setEconomyDeps(costLedger: CostLedger, rateCards?: Record<string, RateCardEntry>, bus?: VinyanBus): void {
    this.costLedger = costLedger;
    this.rateCards = rateCards;
    // Don't clobber an already-wired bus from the constructor — but if a
    // later call provides one, prefer that (factory may pass economy bus
    // after construction).
    if (bus) this.bus = bus;
  }

  /**
   * Track that `taskId` is a delegated child of `parentTaskId`. Subsequent
   * `record()` calls for traces with this `taskId` will inherit the
   * parent linkage automatically. Idempotent. Caller MUST `clearParent`
   * in a finally block — otherwise the map grows unbounded.
   */
  registerParent(taskId: string, parentTaskId: string): void {
    this.pendingParentTaskIds.set(taskId, parentTaskId);
  }

  clearParent(taskId: string): void {
    this.pendingParentTaskIds.delete(taskId);
  }

  async record(trace: ExecutionTrace): Promise<void> {
    // Auto-fill parentTaskId from the registry if the trace builder
    // didn't set it. Individual trace sites can still override (e.g. a
    // synthetic recovery trace might set its own parent linkage).
    if (!trace.parentTaskId) {
      const parent = this.pendingParentTaskIds.get(trace.taskId);
      if (parent) {
        trace = { ...trace, parentTaskId: parent };
      }
    }
    this.traces.push(trace);
    this.persistTrace(trace);

    // Extensible Thinking: emit a measurement event pairing the
    // thinking mode that was used with the actual task outcome. This is
    // the raw material for the thinking readiness gate — see
    // TraceStore.getSuccessRateByThinkingMode. We keep the payload flat
    // (no nested objects) so offline analysis can tail the bus without
    // needing to understand the full ExecutionTrace shape.
    if (this.bus) {
      this.bus.emit('thinking:policy-evaluated', {
        taskId: trace.taskId,
        thinkingMode: trace.thinkingMode ?? null,
        thinkingTokensUsed: trace.thinkingTokensUsed ?? null,
        routingLevel: trace.routingLevel,
        outcome: trace.outcome,
        qualityComposite: trace.qualityScore?.composite ?? null,
        oracleCompositeScore: computeOracleComposite(trace.oracleVerdicts),
      });
    }

    // Economy: record cost entry from trace
    this.recordCost(trace);

    // On success, invalidate World Graph facts for affected files
    // so stale verified facts don't persist after mutations
    if (trace.outcome === 'success' && this.worldGraph) {
      for (const file of trace.affectedFiles) {
        try {
          this.worldGraph.invalidateByFile(file);
        } catch {
          // WorldGraph invalidation is best-effort
        }
      }
    }
  }

  getTraces(): ReadonlyArray<ExecutionTrace> {
    return this.traces;
  }

  getLatestTrace(): ExecutionTrace | undefined {
    return this.traces[this.traces.length - 1];
  }

  getTraceCount(): number {
    if (this.traceStore) {
      try {
        return this.traceStore.count();
      } catch {
        // Fall back to in-memory count
      }
    }
    return this.traces.length;
  }

  /**
   * Price one trace into the cost ledger.
   *
   * Two gates keep the ledger honest now that cost accounting runs by
   * default on every task rather than behind an opt-in flag:
   *
   *  1. Traces that never touched a model are skipped entirely. Eleven call
   *     sites record `modelUsed: 'none'` (conversational turns, no-LLM
   *     phases, budget-blocked stubs); pricing those produced a $0 row plus
   *     an `economy:rate_card_miss` for an engine literally named "none",
   *     which would have been the bulk of the table and would have dragged
   *     every token percentile toward zero.
   *  2. Traces with zero billable token volume are skipped for the same
   *     reason — e.g. the comprehension trace, which carries a real engine
   *     id but `tokensConsumed: 0`. Left in, it also pinned the cost
   *     predictor's EMA to $0.00.
   */
  private recordCost(trace: ExecutionTrace): void {
    if (!this.costLedger) return;

    // Prefer the RE-agnostic engine id; `modelUsed` may still hold a routing
    // tier-label hint rather than a real provider id (see LEVEL_CONFIG).
    const pricingKey = trace.engineId ?? trace.modelUsed;
    if (!pricingKey || pricingKey === 'none') return;

    // A split is only usable when it actually accounts for tokens. Producers
    // that zero-initialise the fields report `tokensInput: 0, tokensOutput: 0`
    // as DEFINED values alongside a real `tokensConsumed` — the multi-persona
    // room path does exactly this (room-supervisor seeds both at 0 and
    // agent-loop omits a field it never incremented). Treating "defined" as
    // "usable" would price those at $0 and, worse, drop the row entirely on
    // the zero-volume gate below, making the whole task invisible to the
    // ledger, the token percentile and the cost predictor.
    const reportedSplit = (trace.tokensInput ?? 0) + (trace.tokensOutput ?? 0);
    const hasSplit = reportedSplit > 0;
    const cacheTokens = (trace.cacheReadTokens ?? 0) + (trace.cacheCreationTokens ?? 0);
    const billableTokens = (hasSplit ? reportedSplit : trace.tokensConsumed) + cacheTokens;
    if (billableTokens <= 0) return;

    try {
      const card = resolveRateCard(pricingKey, this.rateCards);
      // Output tokens bill at up to 5x input, so the split decides the price.
      // Engines that report it get charged correctly; the rest fall back to
      // pricing the total as input, which under-reports rather than invents
      // a split the trace cannot support.
      const tokensInput = hasSplit ? (trace.tokensInput ?? 0) : trace.tokensConsumed;
      const tokensOutput = hasSplit ? (trace.tokensOutput ?? 0) : 0;
      if (!hasSplit) {
        // Make the under-reporting path countable instead of invisible.
        this.bus?.emit('economy:cost_estimated_no_split', {
          taskId: trace.taskId,
          engineId: pricingKey,
          tokensConsumed: trace.tokensConsumed,
        });
      }
      const costResult = computeCost(
        {
          input: tokensInput,
          output: tokensOutput,
          cacheRead: trace.cacheReadTokens,
          cacheCreation: trace.cacheCreationTokens,
        },
        card,
      );
      if (!card) {
        this.bus?.emit('economy:rate_card_miss', { engineId: pricingKey, fallback: 'estimated' });
      }
      // A5: `billing` asserts deterministic pricing authority. A routing
      // tier label ('claude-sonnet' at L2) is a human-readable HINT, not the
      // engine that served the request — phase-predict normally rewrites it
      // to the real provider id, and when it hasn't the glob still matches
      // and would stamp a guess as billing-grade. Downgrade those to
      // `estimated` so the tier is honest about what it knows.
      const costTier = card && isRoutingTierLabel(pricingKey) ? 'estimated' : costResult.cost_tier;
      this.costLedger.record({
        // cost_ledger.id is a TEXT PRIMARY KEY and the table has no natural
        // key: one task records several traces, and some trace ids are
        // deterministic per task (comprehension, escalated, contradiction),
        // so neither `taskId:timestamp` nor `trace.id` alone is unique. The
        // monotonic sequence makes collisions structurally impossible.
        id: `${trace.id}:${trace.timestamp}:${nextLedgerSeq()}`,
        traceId: trace.id,
        taskId: trace.taskId,
        workerId: trace.workerId ?? null,
        engineId: pricingKey,
        timestamp: trace.timestamp,
        tokens_input: tokensInput,
        tokens_output: tokensOutput,
        cache_read_tokens: trace.cacheReadTokens ?? 0,
        cache_creation_tokens: trace.cacheCreationTokens ?? 0,
        duration_ms: trace.durationMs,
        oracle_invocations: Object.keys(trace.oracleVerdicts ?? {}).length,
        computed_usd: costResult.computed_usd,
        cost_tier: costTier,
        routing_level: trace.routingLevel,
        task_type_signature: trace.taskTypeSignature ?? null,
      });
      this.bus?.emit('economy:cost_recorded', {
        taskId: trace.taskId,
        engineId: pricingKey,
        computed_usd: costResult.computed_usd,
        cost_tier: costTier,
      });
    } catch {
      // Economy recording is best-effort
    }
  }

  private persistTrace(trace: ExecutionTrace): void {
    if (!this.traceStore) return;
    try {
      this.traceStore.insert(trace);
    } catch (err) {
      this.bus?.emit('trace:write_failed', {
        taskId: trace.taskId,
        traceId: trace.id,
        error: String(err),
      });
      console.warn('[vinyan] Trace INSERT failed:', err);
      if (requiresDurablePersistence(trace)) {
        throw new TracePersistenceError(trace, err);
      }
    }
  }
}

/**
 * Monotonic sequence for cost-ledger row ids. Module-level so every
 * TraceCollector in a process shares it.
 */
let ledgerSeq = 0;
function nextLedgerSeq(): number {
  ledgerSeq += 1;
  return ledgerSeq;
}

/**
 * The tier-label hints `risk-router` seeds `routing.model` with
 * ('claude-haiku' / 'claude-sonnet' / 'claude-opus'). Derived from
 * LEVEL_CONFIG so the set cannot drift from the router.
 */
const ROUTING_TIER_LABELS: ReadonlySet<string> = new Set(
  Object.values(LEVEL_CONFIG)
    .map((cfg) => cfg.model)
    .filter((m): m is string => m !== null),
);

function isRoutingTierLabel(pricingKey: string): boolean {
  return ROUTING_TIER_LABELS.has(pricingKey);
}

function requiresDurablePersistence(trace: ExecutionTrace): boolean {
  return trace.governanceProvenance !== undefined;
}

/**
 * Extensible Thinking: compute a scalar composite from an oracle
 * verdict map. Used as the secondary signal in the thinking readiness gate
 * (the primary signal is binary outcome=success). Returns null when there are
 * no verdicts so downstream consumers can tell "no signal" apart from
 * "signal = 0".
 *
 * NB: trace-level verdicts are stored as `Record<string, boolean>` — the
 * richer `OracleVerdict` (with confidence, etc.) is only kept on the live
 * mutation result, not the persisted trace. So the composite is just the
 * fraction of oracles that returned `true`, which is the right level of
 * granularity for the A/B measurement gate — future evolution will switch
 * to a Wilson/CI rollup once we have enough data to need it.
 */
function computeOracleComposite(verdicts: Record<string, boolean> | undefined): number | null {
  if (!verdicts) return null;
  const entries = Object.values(verdicts);
  if (entries.length === 0) return null;
  let passes = 0;
  for (const v of entries) {
    if (v === true) passes++;
  }
  return passes / entries.length;
}
