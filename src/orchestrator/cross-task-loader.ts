/**
 * Cross-Task Loader — loads prior failed approaches from rejected_approaches table.
 *
 * Enables cross-task learning: Task B loads Task A's verified failures so it doesn't
 * repeat the same mistakes. Approaches are matched by (file_target, task_type) with
 * deduplication and confidence downgrade.
 *
 * Gap 8A: Verb-aware loading — verb-matched approaches get standard confidence,
 * verb-mismatched get stronger downgrade (0.4 vs 0.7).
 *
 * Design ref: memory-prompt-architecture-system-design.md §2.2a
 */
import type { RejectedApproachStore } from '../db/rejected-approach-store.ts';
import type { WorkingMemoryState } from './types.ts';

/** Cross-task confidence downgrade for verb-matched approaches. */
const CROSS_TASK_CONFIDENCE_FACTOR = 0.7;
/** Stronger downgrade for verb-mismatched approaches (Gap 8A). */
const CROSS_TASK_VERB_MISMATCH_FACTOR = 0.4;

/** Maximum approaches to load from prior tasks. */
const MAX_CROSS_TASK_APPROACHES = 5;

/** Load prior failed approaches for a new task, injecting them as working memory entries.
 *  Returns approaches ready to merge into WorkingMemory.failedApproaches.
 *  @param actionVerb — Gap 8A: if provided, uses verb-aware loading with differential confidence. */
export function loadPriorFailedApproaches(
  store: RejectedApproachStore,
  fileTarget: string,
  taskType: string,
  currentApproaches?: WorkingMemoryState['failedApproaches'],
  actionVerb?: string,
): WorkingMemoryState['failedApproaches'] {
  // Gap 8A: Use verb-aware query when actionVerb is available
  const rows = actionVerb && 'loadForTaskWithVerb' in store
    ? store.loadForTaskWithVerb(fileTarget, taskType, actionVerb, MAX_CROSS_TASK_APPROACHES)
    : store.loadForTask(fileTarget, taskType, MAX_CROSS_TASK_APPROACHES);

  // Build dedup set from current task's approaches (approach + verdict)
  const seen = new Set(
    (currentApproaches ?? []).map((a) => `${a.approach}::${a.oracleVerdict}`),
  );

  const result: WorkingMemoryState['failedApproaches'] = [];
  for (const row of rows) {
    // Dedup: skip if same approach already in current task
    const key = `${row.approach}::${row.oracle_verdict}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Gap 8A: Stronger downgrade for verb mismatch
    const verbMatches = !actionVerb || row.action_verb === actionVerb || !row.action_verb;
    const factor = verbMatches ? CROSS_TASK_CONFIDENCE_FACTOR : CROSS_TASK_VERB_MISMATCH_FACTOR;

    result.push({
      approach: row.approach,
      oracleVerdict: row.oracle_verdict,
      timestamp: row.created_at,
      verdictConfidence: (row.verdict_confidence ?? 0.5) * factor,
      failureOracle: row.failure_oracle ?? undefined,
      source: 'cross-task',
    });
  }

  return result;
}
