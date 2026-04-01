/**
 * Trace Collector — records execution traces and invalidates World Graph on success.
 *
 * Supports optional SQLite persistence via TraceStore injection.
 * Without TraceStore: in-memory only (backward compatible, used in tests).
 * With TraceStore: dual-write to memory + SQLite for Phase 2 Sleep Cycle queries.
 *
 * Source of truth: spec/tdd.md §12B (Execution Traces), §16 (Core Loop Step 6: LEARN)
 */

import type { TraceStore } from '../db/trace-store.ts';
import type { WorldGraph } from '../world-graph/world-graph.ts';
import type { TraceCollector } from './core-loop.ts';
import type { ExecutionTrace } from './types.ts';

export class TraceCollectorImpl implements TraceCollector {
  private traces: ExecutionTrace[] = [];
  private worldGraph?: WorldGraph;
  private traceStore?: TraceStore;

  constructor(worldGraph?: WorldGraph, traceStore?: TraceStore) {
    this.worldGraph = worldGraph;
    this.traceStore = traceStore;
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
