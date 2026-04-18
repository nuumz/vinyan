/**
 * User-Context types — shared shape for the interest miner and prompt rendering.
 *
 * A3 note: These are self-reported / heuristic-derived signals, never used to
 * drive governance decisions. They only enrich classifier / prompt context.
 */

export interface TaskTypeCount {
  /** Trace `task_type_signature` (e.g. "fix::ts::small" or "reasoning::general"). */
  signature: string;
  count: number;
}

export interface KeywordFrequency {
  term: string;
  frequency: number;
}

export interface UserContextSnapshot {
  /** Top task-type signatures by count over the lookback window. */
  frequentTaskTypes: TaskTypeCount[];
  /** Top keywords extracted from recent user messages (stop-word filtered). */
  recentKeywords: KeywordFrequency[];
  /** Coarse domain labels derived from signatures (e.g. "creative-writing", "code-mutation"). */
  recentDomains: string[];
  /** Sanity-check count of traces seen within the lookback window. */
  totalTracesInWindow: number;
  /** Last trace timestamp (ms) — null when cold-start. */
  lastActiveAt: number | null;
}

/** Lookup options for the miner. */
export interface MineOptions {
  /** Session id for keyword extraction (optional — may still get task types without it). */
  sessionId?: string;
  /** How far back to look for traces. Default: 30 days. */
  lookbackDays?: number;
  /** Max task types returned. Default: 5. */
  maxTaskTypes?: number;
  /** Max keywords returned. Default: 10. */
  maxKeywords?: number;
  /** Min keyword length to consider. Default: 3. */
  minKeywordLen?: number;
}

export const EMPTY_SNAPSHOT: UserContextSnapshot = {
  frequentTaskTypes: [],
  recentKeywords: [],
  recentDomains: [],
  totalTracesInWindow: 0,
  lastActiveAt: null,
};

/** True when the snapshot has no meaningful signal (cold-start case). */
export function isEmpty(snapshot: UserContextSnapshot): boolean {
  return (
    snapshot.frequentTaskTypes.length === 0 &&
    snapshot.recentKeywords.length === 0 &&
    snapshot.recentDomains.length === 0
  );
}
