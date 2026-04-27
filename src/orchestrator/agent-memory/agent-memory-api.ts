/**
 * AgentMemoryAPI — unified read-only query surface over Vinyan's memory substrate.
 *
 * Wave 3 MVP: second-brain reads for workers/agents mid-task.
 * A1: read-only from generation path — never mutates.
 * A3: returns data only, makes no governance decisions.
 * A6: zero side effects (pure reads + per-task LRU cache).
 */
import type { Fact } from '../../core/types.ts';
import type { RejectedApproachRow } from '../../db/rejected-approach-store.ts';
import type { CachedSkill, EvolutionaryRule, ExecutionTrace, HistoricalProfile } from '../types.ts';

export interface QueryFactsOptions {
  /** Drop facts whose (post-decay) confidence falls below this threshold. */
  minConfidence?: number;
}

export interface QueryFailedApproachesOptions {
  /** Narrow to a specific file target (falls back to type-only if missing). */
  file?: string;
  /** Max rows (default: 5). */
  limit?: number;
}

export interface QueryRelatedSkillsOptions {
  /** Top-k to return (default: 5). */
  k?: number;
}

export interface QueryPriorTracesOptions {
  /** Max traces (default: 10). */
  limit?: number;
}

/** Read-only query surface over Vinyan's memory stores. */
export interface AgentMemoryAPI {
  /** World Graph facts for a file/symbol target. */
  queryFacts(target: string, opts?: QueryFactsOptions): Promise<Fact[]>;

  /** Prior rejected approaches for a task type (optionally narrowed by file). */
  queryFailedApproaches(taskType: string, opts?: QueryFailedApproachesOptions): Promise<RejectedApproachRow[]>;

  /** Skills with signatures similar to taskSig (bigram Jaccard, top-k). */
  queryRelatedSkills(taskSig: string, opts?: QueryRelatedSkillsOptions): Promise<CachedSkill[]>;

  /** Prior execution traces for a task type signature. */
  queryPriorTraces(taskSig: string, opts?: QueryPriorTracesOptions): Promise<ExecutionTrace[]>;

  /** Active evolutionary rules matching a file pattern. */
  queryRules(filePattern: string): Promise<EvolutionaryRule[]>;

  /** Historical profile for a task type signature. */
  queryHistoricalProfile(taskType: string): Promise<HistoricalProfile | null>;

  /** Begin per-task cache scope. Cache is keyed `${taskId}:${method}:${argsHash}`. */
  beginTask(taskId: string): void;

  /** Drop the per-task cache scope. Queries without a scope still work (fresh fetch). */
  endTask(taskId: string): void;

  // ── Wave A: Write path (optional, backward compat) ─────────────────

  /** Persist a learned pattern into PatternStore. Invalidates affected cache. */
  recordLearnedPattern?(pattern: {
    type: string;
    taskSignature: string;
    data: Record<string, unknown>;
    confidence: number;
  }): void;

  /** Write a fact update through to WorldGraph. Invalidates affected cache. */
  recordFactUpdate?(fact: Fact): void;

  /**
   * Persist a failed-approach record into RejectedApproachStore. Closes the
   * write side of the loop so future planners that call
   * `queryFailedApproaches` actually see what failed last time.
   *
   * Optional: callers degrade gracefully when the store is unwired (mirrors
   * the existing `recordLearnedPattern?` / `recordFactUpdate?` shape). All
   * implementations must be best-effort — recording is observability, not a
   * correctness gate.
   */
  recordFailedApproach?(entry: {
    taskId: string;
    taskType: string;
    /** Compact descriptor of the strategy that failed (e.g. "agentic-workflow:llm-reasoning,llm-reasoning"). */
    approach: string;
    /** Discriminator for filtering: 'workflow-step-failed', 'workflow-deadlock', 'workflow-timeout'. */
    failureOracle: string;
    /** Routing level the failure occurred at (2 for workflow path). */
    routingLevel: number;
    /** First targetFile, when present — drives file+type matching at query time. */
    fileTarget?: string;
    /** Action verb extracted from the goal — drives verb-aware cross-task matching. */
    actionVerb?: string;
  }): Promise<void>;
}
