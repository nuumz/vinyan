/**
 * Memory Wiki — task trace ingestion bridge.
 *
 * Subscribes to `task:complete` and turns high-signal task results into
 * `MemoryWikiIngestor.ingestTrace()` calls. Companion to the session
 * bridge: sessions capture conversational mass; traces capture the
 * orchestrator's verification/governance trail per task.
 *
 * Signal gate — by default we keep:
 *   - non-success outcomes (`failed`, `escalated`, `uncertain`,
 *     `partial`, `input-required`) — these are the wiki-worthy moments
 *     because they expose failure modes, escalation triggers, and
 *     unresolved questions;
 *   - any task that escalated to L2 or L3 (substantial reasoning, even
 *     when ultimately successful);
 *   - tasks with `predictionError` recorded in trace metadata (A7 hits).
 *
 * Routine successful L0/L1 tasks are dropped to keep the wiki from
 * filling with noise. Operators can override the gate via opts to
 * widen or narrow the filter at runtime.
 *
 * Idempotent: ingestor uses content-addressed source ids
 * (post-α deriveSourceId fix), so a re-emitted `task:complete` for the
 * same task collapses to one row.
 *
 * Best-effort: every failure is caught and routed through `onError`;
 * the bus and orchestrator never see the error.
 */
import type { VinyanBus } from '../../core/bus.ts';
import type { ExecutionTrace, TaskResult } from '../../orchestrator/types.ts';
import type { MemoryWikiIngestor } from './ingest.ts';

export type TraceIngestionDecision = 'ingest' | 'skip';

export interface TraceBridgeOptions {
  readonly bus: VinyanBus;
  readonly ingestor: MemoryWikiIngestor;
  readonly defaultProfile: string;
  /**
   * Override the default signal gate. Receives the task result and
   * returns whether to ingest. Default keeps all non-success outcomes
   * plus L2/L3 successes.
   */
  readonly shouldIngest?: (result: TaskResult) => TraceIngestionDecision;
  readonly clock?: () => number;
  readonly dispatcher?: (fn: () => void) => void;
  readonly onError?: (taskId: string, err: unknown) => void;
}

export interface TraceBridge {
  off(): void;
}

const defaultDispatcher = (fn: () => void): void => {
  queueMicrotask(fn);
};

const defaultOnError = (taskId: string, err: unknown): void => {
  console.warn(`[vinyan-wiki] trace ingestion failed for task ${taskId}:`, err instanceof Error ? err.message : err);
};

/**
 * Default signal gate. Keeps any task that produced reasoning mass the
 * wiki can summarize:
 *
 *   - routingLevel >= 1 (L1 heuristic / L2 analytical / L3 deliberative)
 *   - non-`completed` status (failed, escalated, uncertain, partial,
 *     input-required)
 *   - non-`success` trace outcomes
 *   - any prediction-error record (A7 — claimed-vs-actual divergence)
 *
 * Only L0 routine successes are dropped — they are reflex-tier replies
 * with no oracle/agent verification trail to extract from. Earlier
 * versions also dropped L1 successes; that proved too noisy a filter
 * for live operators (the wiki stayed near-empty even after dozens of
 * tasks completed because most tool-using turns route at L0 with a
 * short-circuit success). Operators that want the older filter pass
 * `shouldIngest: highSignalTraceGate`.
 */
export function defaultTraceGate(result: TaskResult): TraceIngestionDecision {
  if (result.status !== 'completed') return 'ingest';
  const trace = result.trace;
  if (trace.routingLevel >= 1) return 'ingest';
  if (trace.outcome && trace.outcome !== 'success') return 'ingest';
  if (trace.predictionError) return 'ingest';
  return 'skip';
}

/**
 * Stricter gate that mirrors the pre-2026-05 behavior: only L2+ successes
 * or non-success outcomes pass. Exposed so deployments that hit wiki
 * volume pressure can opt back into the noisier filter without forking.
 */
export function highSignalTraceGate(result: TaskResult): TraceIngestionDecision {
  if (result.status !== 'completed') return 'ingest';
  const trace = result.trace;
  if (trace.routingLevel >= 2) return 'ingest';
  if (trace.outcome && trace.outcome !== 'success') return 'ingest';
  if (trace.predictionError) return 'ingest';
  return 'skip';
}

export function attachTraceBridge(opts: TraceBridgeOptions): TraceBridge {
  const dispatch = opts.dispatcher ?? defaultDispatcher;
  const onError = opts.onError ?? defaultOnError;
  const gate = opts.shouldIngest ?? defaultTraceGate;

  const handle = (result: TaskResult): void => {
    if (gate(result) === 'skip') return;
    dispatch(() => {
      try {
        const summary = buildTraceSummaryMarkdown(result);
        opts.ingestor.ingestTrace({
          profile: opts.defaultProfile,
          trace: result.trace,
          summaryMarkdown: summary,
        });
      } catch (err) {
        onError(result.id, err);
      }
    });
  };

  const offHandler = opts.bus.on('task:complete', (e) => handle(e.result));

  let detached = false;
  return {
    off(): void {
      if (detached) return;
      detached = true;
      offHandler();
    },
  };
}

// ── Pure markdown builder (exported for tests) ──────────────────────────

/**
 * Render an `ExecutionTrace` plus task-level metadata as markdown
 * suitable for `ingestSource(kind: 'trace')`. Pure and deterministic.
 */
export function buildTraceSummaryMarkdown(result: TaskResult): string {
  const t: ExecutionTrace = result.trace;
  const lines: string[] = [];
  lines.push(`# Task ${result.id} — ${result.status}`);
  lines.push('');
  lines.push(`- **Routing**: L${t.routingLevel}`);
  lines.push(`- **Outcome**: ${t.outcome}`);
  lines.push(`- **Duration**: ${t.durationMs}ms`);
  if (t.modelUsed) lines.push(`- **Model**: ${t.modelUsed}`);
  if (t.tokensConsumed != null) lines.push(`- **Tokens**: ${t.tokensConsumed}`);
  if (t.qualityScore?.composite != null) {
    lines.push(`- **Quality**: ${t.qualityScore.composite.toFixed(3)}`);
  }
  if (t.verificationConfidence != null) {
    lines.push(`- **Verification confidence**: ${t.verificationConfidence.toFixed(3)}`);
  }
  if (t.affectedFiles && t.affectedFiles.length > 0) {
    lines.push(`- **Files**: ${t.affectedFiles.slice(0, 8).join(', ')}`);
  }

  if (result.escalationReason) {
    lines.push('');
    lines.push('## Escalation reason');
    lines.push('');
    lines.push(result.escalationReason);
  }

  if (result.contradictions && result.contradictions.length > 0) {
    lines.push('');
    lines.push('## Contradictions');
    for (const c of result.contradictions.slice(0, 6)) {
      lines.push(`- ${c}`);
    }
  }

  if (result.notes && result.notes.length > 0) {
    lines.push('');
    lines.push('## Audit notes');
    for (const n of result.notes.slice(0, 6)) {
      lines.push(`- ${n}`);
    }
  }

  const verdicts = Object.entries(t.oracleVerdicts ?? {});
  if (verdicts.length > 0) {
    lines.push('');
    lines.push(`## Oracle verdicts (${verdicts.length})`);
    for (const [name, ok] of verdicts.slice(0, 8)) {
      lines.push(`- \`${name}\` → ${ok ? 'pass' : 'fail'}`);
    }
  }

  if (t.predictionError) {
    lines.push('');
    lines.push('## Prediction error (A7)');
    lines.push('');
    lines.push('```json');
    lines.push(JSON.stringify(t.predictionError, null, 2));
    lines.push('```');
  }

  if (result.answer) {
    lines.push('');
    lines.push('## Answer');
    lines.push('');
    lines.push(result.answer.slice(0, 1_500));
  }

  return lines.join('\n');
}
