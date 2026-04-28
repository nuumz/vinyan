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
    if (this.costLedger && trace.modelUsed) {
      try {
        const card = resolveRateCard(trace.modelUsed, this.rateCards);
        const costResult = computeCost(
          {
            input: trace.tokensConsumed,
            output: 0, // tokensConsumed is total; split unavailable at trace level
            cacheRead: trace.cacheReadTokens,
            cacheCreation: trace.cacheCreationTokens,
          },
          card,
        );
        if (!card) {
          this.bus?.emit('economy:rate_card_miss', { engineId: trace.modelUsed, fallback: 'estimated' });
        }
        this.costLedger.record({
          id: `${trace.taskId}:${trace.timestamp}`,
          taskId: trace.taskId,
          workerId: trace.workerId ?? null,
          engineId: trace.modelUsed,
          timestamp: trace.timestamp,
          tokens_input: trace.tokensConsumed,
          tokens_output: 0,
          cache_read_tokens: trace.cacheReadTokens ?? 0,
          cache_creation_tokens: trace.cacheCreationTokens ?? 0,
          duration_ms: trace.durationMs,
          oracle_invocations: Object.keys(trace.oracleVerdicts ?? {}).length,
          computed_usd: costResult.computed_usd,
          cost_tier: costResult.cost_tier,
          routing_level: trace.routingLevel,
          task_type_signature: trace.taskTypeSignature ?? null,
        });
        this.bus?.emit('economy:cost_recorded', {
          taskId: trace.taskId,
          engineId: trace.modelUsed,
          computed_usd: costResult.computed_usd,
          cost_tier: costResult.cost_tier,
        });
      } catch {
        // Economy recording is best-effort
      }
    }

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
