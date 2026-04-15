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
}
