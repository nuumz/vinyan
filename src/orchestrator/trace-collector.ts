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
import type { CostLedger } from '../economy/cost-ledger.ts';
import type { RateCardEntry } from '../economy/economy-config.ts';
import { computeCost } from '../economy/cost-computer.ts';
import { resolveRateCard } from '../economy/rate-card.ts';
import type { WorldGraph } from '../world-graph/world-graph.ts';
import type { TraceCollector } from './core-loop.ts';
import type { ExecutionTrace } from './types.ts';

export class TraceCollectorImpl implements TraceCollector {
  private traces: ExecutionTrace[] = [];
  private worldGraph?: WorldGraph;
  private traceStore?: TraceStore;
  private costLedger?: CostLedger;
  private rateCards?: Record<string, RateCardEntry>;
  private bus?: VinyanBus;

  constructor(worldGraph?: WorldGraph, traceStore?: TraceStore) {
    this.worldGraph = worldGraph;
    this.traceStore = traceStore;
  }

  /** Wire economy dependencies after construction (avoids circular deps). */
  setEconomyDeps(costLedger: CostLedger, rateCards?: Record<string, RateCardEntry>, bus?: VinyanBus): void {
    this.costLedger = costLedger;
    this.rateCards = rateCards;
    this.bus = bus;
  }

  async record(trace: ExecutionTrace): Promise<void> {
    this.traces.push(trace);

    // Persist to SQLite if store is available
    if (this.traceStore) {
      try {
        this.traceStore.insert(trace);
      } catch (err) {
        console.warn('[vinyan] Trace INSERT failed:', err);
      }
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
}
