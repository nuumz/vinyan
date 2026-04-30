/**
 * Historical Adversary — builds the `[HISTORICAL EVIDENCE]` slice of the
 * critic context from the read-only `AgentMemoryAPI` surface.
 *
 * Pattern lifted from obsidian-second-brain's `/obsidian-challenge` (vault
 * red-teams a proposal using the user's own decision/failure history). For
 * Vinyan, the equivalent evidence is:
 *   1. Prior rejected approaches that share this task's signature/file.
 *   2. Aggregate outcome counts of prior traces with the same signature.
 *
 * Both come from `AgentMemoryAPI` (Wave 3 read-only surface, A1 + A6 safe).
 * The output is an opt-in fragment of `CriticContext` that the orchestrator
 * threads into `criticEngine.review()`. When unwired, behavior is unchanged.
 *
 * Axiom anchor:
 *   - A1 Epistemic Separation: this helper does not generate; it only reads
 *     past oracle verdicts and trace outcomes.
 *   - A6 Zero-Trust: pure read path, no side effects.
 *   - A7 Prediction Error as Learning: surfaces "you tried X N times, it
 *     failed each time" so the critic can act on observed base-rate.
 *
 * Source: docs/design/knowledge-loop-rfc.md §5 (Phase C1).
 */
import type { AgentMemoryAPI } from '../agent-memory/agent-memory-api.ts';
import type { CriticContext } from './critic-engine.ts';

export interface HistoricalAdversaryOptions {
  /** Task signature used for `queryFailedApproaches` + `queryPriorTraces`. */
  taskSignature: string;
  /** First target file, when present — narrows the rejected-approach query. */
  fileTarget?: string;
  /** Cap on rejected-approach rows pulled from memory (default: 20). */
  failedLimit?: number;
  /** Cap on prior-trace rows pulled from memory (default: 20). */
  traceLimit?: number;
}

export type HistoricalAdversaryFragment = Pick<CriticContext, 'priorFailedApproaches' | 'priorTraceSummary'>;

const DEFAULT_FAILED_LIMIT = 20;
const DEFAULT_TRACE_LIMIT = 20;

/**
 * Orchestrator-side wiring helper. Call site signature mirrors the data
 * already available at the critic invocation point (`agentMemory` from
 * deps, `taskTypeSignature` from `understanding`, `targetFiles` from
 * `TaskInput`). Returns the input context unchanged when the feature is
 * off, agentMemory is unwired, or task signature is missing — so callers
 * can wrap it unconditionally without paying for the no-op cases.
 */
export async function maybeAttachHistoricalAdversary<T extends object>(
  baseContext: T,
  deps: {
    readonly agentMemory?: AgentMemoryAPI;
    readonly criticHistoricalAdversaryEnabled?: boolean;
  },
  taskInfo: {
    readonly taskSignature?: string | null;
    readonly fileTarget?: string | undefined;
  },
): Promise<T & HistoricalAdversaryFragment> {
  if (!deps.criticHistoricalAdversaryEnabled) return baseContext as T & HistoricalAdversaryFragment;
  if (!deps.agentMemory) return baseContext as T & HistoricalAdversaryFragment;
  if (!taskInfo.taskSignature) return baseContext as T & HistoricalAdversaryFragment;

  const fragment = await buildHistoricalAdversaryContext(deps.agentMemory, {
    taskSignature: taskInfo.taskSignature,
    ...(taskInfo.fileTarget !== undefined ? { fileTarget: taskInfo.fileTarget } : {}),
  }).catch((): HistoricalAdversaryFragment => ({}));

  return { ...baseContext, ...fragment };
}

/**
 * Build the `priorFailedApproaches` + `priorTraceSummary` fragment of
 * CriticContext for the given task signature.
 *
 * Returns an empty fragment (no mutations to context) when memory has
 * nothing to say. Callers can spread the result into an existing context:
 *
 * ```ts
 * const adversary = await buildHistoricalAdversaryContext(memory, {
 *   taskSignature: trace.taskTypeSignature,
 *   fileTarget: task.targetFiles?.[0],
 * });
 * await critic.review(proposal, task, perception, criteria, { ...ctx, ...adversary });
 * ```
 */
export async function buildHistoricalAdversaryContext(
  memory: AgentMemoryAPI,
  opts: HistoricalAdversaryOptions,
): Promise<HistoricalAdversaryFragment> {
  const failedLimit = opts.failedLimit ?? DEFAULT_FAILED_LIMIT;
  const traceLimit = opts.traceLimit ?? DEFAULT_TRACE_LIMIT;

  const [rejectedRows, priorTraces] = await Promise.all([
    memory
      .queryFailedApproaches(opts.taskSignature, {
        ...(opts.fileTarget !== undefined ? { file: opts.fileTarget } : {}),
        limit: failedLimit,
      })
      .catch(() => []),
    memory.queryPriorTraces(opts.taskSignature, { limit: traceLimit }).catch(() => []),
  ]);

  const fragment: HistoricalAdversaryFragment = {};

  const priorFailedApproaches = aggregateFailedApproaches(rejectedRows);
  if (priorFailedApproaches.length > 0) {
    fragment.priorFailedApproaches = priorFailedApproaches;
  }

  const priorTraceSummary = summarizePriorTraces(priorTraces);
  if (priorTraceSummary) {
    fragment.priorTraceSummary = priorTraceSummary;
  }

  return fragment;
}

// ---------------------------------------------------------------------------
// Aggregation helpers
// ---------------------------------------------------------------------------

interface AggregatedFailure {
  approach: string;
  failureOracle: string;
  occurrences: number;
  lastSeenAt: number;
}

function aggregateFailedApproaches(
  rows: ReadonlyArray<{ approach: string; failure_oracle: string | null; created_at: number }>,
): AggregatedFailure[] {
  const buckets = new Map<string, AggregatedFailure>();
  for (const row of rows) {
    // Skip rows without a classified failure — they carry no adversarial
    // signal beyond "something failed", which is too vague for the critic.
    if (!row.failure_oracle) continue;
    const key = `${row.approach}::${row.failure_oracle}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.occurrences += 1;
      if (row.created_at > existing.lastSeenAt) existing.lastSeenAt = row.created_at;
      continue;
    }
    buckets.set(key, {
      approach: row.approach,
      failureOracle: row.failure_oracle,
      occurrences: 1,
      lastSeenAt: row.created_at,
    });
  }
  return [...buckets.values()].sort((a, b) => b.occurrences - a.occurrences || b.lastSeenAt - a.lastSeenAt);
}

interface TraceSummary {
  totalAttempts: number;
  successCount: number;
  failureCount: number;
  mostCommonEscalation?: number;
}

function summarizePriorTraces(
  traces: ReadonlyArray<{ outcome: string; routingLevel: number }>,
): TraceSummary | undefined {
  if (traces.length === 0) return undefined;

  let success = 0;
  let failure = 0;
  const levelCounts = new Map<number, number>();

  for (const t of traces) {
    if (t.outcome === 'success') success += 1;
    else if (t.outcome === 'failure' || t.outcome === 'timeout' || t.outcome === 'escalated') failure += 1;
    // 'partial' is not counted on either side — it's neither a clean success
    // nor an outright failure for base-rate purposes.

    const level = t.routingLevel;
    levelCounts.set(level, (levelCounts.get(level) ?? 0) + 1);
  }

  let modal: number | undefined;
  let modalCount = 0;
  for (const [level, count] of levelCounts) {
    if (count > modalCount) {
      modal = level;
      modalCount = count;
    }
  }

  const summary: TraceSummary = {
    totalAttempts: traces.length,
    successCount: success,
    failureCount: failure,
  };
  if (modal !== undefined) summary.mostCommonEscalation = modal;
  return summary;
}
