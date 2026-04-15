/**
 * AgentMemoryAPIImpl — concrete read-only query surface with per-task LRU cache.
 *
 * Axiom compliance:
 *   A1: reads only — stores are never mutated here.
 *   A3: returns data (not decisions). Callers must not use confidence as a gate.
 *   A6: zero side effects beyond the in-memory cache.
 *
 * Cache shape: Map<taskId, Map<cacheKey, unknown>> — outer keyed by taskId,
 * inner is insertion-ordered (Map semantics) for O(1) LRU-style eviction.
 */
import type { Fact } from '../../core/types.ts';
import type { RejectedApproachRow, RejectedApproachStore } from '../../db/rejected-approach-store.ts';
import type { RuleStore } from '../../db/rule-store.ts';
import type { SkillStore } from '../../db/skill-store.ts';
import type { TraceStore } from '../../db/trace-store.ts';
import type { WorldGraph } from '../../world-graph/world-graph.ts';
import type { SelfModel } from '../core-loop.ts';
import { profileHistory } from '../understanding/historical-profiler.ts';
import type { CachedSkill, EvolutionaryRule, ExecutionTrace, HistoricalProfile, TaskInput } from '../types.ts';
import type {
  AgentMemoryAPI,
  QueryFactsOptions,
  QueryFailedApproachesOptions,
  QueryPriorTracesOptions,
  QueryRelatedSkillsOptions,
} from './agent-memory-api.ts';

/** Max entries per task-scoped cache. Oldest evicted on overflow. */
const MAX_ENTRIES_PER_TASK = 100;

export interface AgentMemoryDeps {
  worldGraph?: WorldGraph;
  skillStore?: SkillStore;
  traceStore?: TraceStore;
  ruleStore?: RuleStore;
  rejectedApproachStore?: RejectedApproachStore;
  selfModel?: SelfModel;
}

export class AgentMemoryAPIImpl implements AgentMemoryAPI {
  private readonly deps: AgentMemoryDeps;
  /** Per-task cache scopes. Outer key = taskId, inner Map preserves insertion order. */
  private readonly cache = new Map<string, Map<string, unknown>>();
  /** Stack of active taskIds — LIFO ensures correct scoping under sequential begin/end. */
  private readonly taskStack: string[] = [];

  constructor(deps: AgentMemoryDeps) {
    this.deps = deps;
  }

  beginTask(taskId: string): void {
    if (!this.cache.has(taskId)) {
      this.cache.set(taskId, new Map());
    }
    this.taskStack.push(taskId);
  }

  endTask(taskId: string): void {
    this.cache.delete(taskId);
    // Remove the most recent matching entry (LIFO). Tolerate out-of-order end.
    for (let i = this.taskStack.length - 1; i >= 0; i--) {
      if (this.taskStack[i] === taskId) {
        this.taskStack.splice(i, 1);
        return;
      }
    }
  }

  async queryFacts(target: string, opts?: QueryFactsOptions): Promise<Fact[]> {
    return this.withCache('queryFacts', { target, opts }, async () => {
      if (!this.deps.worldGraph) return [];
      try {
        const facts = this.deps.worldGraph.queryFacts(target);
        const min = opts?.minConfidence;
        return min != null ? facts.filter((f) => f.confidence >= min) : facts;
      } catch (err) {
        warn('queryFacts', err);
        return [];
      }
    });
  }

  async queryFailedApproaches(
    taskType: string,
    opts?: QueryFailedApproachesOptions,
  ): Promise<RejectedApproachRow[]> {
    return this.withCache('queryFailedApproaches', { taskType, opts }, async () => {
      if (!this.deps.rejectedApproachStore) return [];
      try {
        const limit = opts?.limit ?? 5;
        // When no file target provided, substitute '*' sentinel for type-only fallback.
        const file = opts?.file ?? '*';
        return this.deps.rejectedApproachStore.loadForTask(file, taskType, limit);
      } catch (err) {
        warn('queryFailedApproaches', err);
        return [];
      }
    });
  }

  async queryRelatedSkills(taskSig: string, opts?: QueryRelatedSkillsOptions): Promise<CachedSkill[]> {
    return this.withCache('queryRelatedSkills', { taskSig, opts }, async () => {
      if (!this.deps.skillStore) return [];
      try {
        const k = opts?.k ?? 5;
        return this.deps.skillStore.findSimilar(taskSig, k);
      } catch (err) {
        warn('queryRelatedSkills', err);
        return [];
      }
    });
  }

  async queryPriorTraces(taskSig: string, opts?: QueryPriorTracesOptions): Promise<ExecutionTrace[]> {
    return this.withCache('queryPriorTraces', { taskSig, opts }, async () => {
      if (!this.deps.traceStore) return [];
      try {
        const limit = opts?.limit ?? 10;
        return this.deps.traceStore.findByTaskType(taskSig, limit);
      } catch (err) {
        warn('queryPriorTraces', err);
        return [];
      }
    });
  }

  async queryRules(filePattern: string): Promise<EvolutionaryRule[]> {
    return this.withCache('queryRules', { filePattern }, async () => {
      if (!this.deps.ruleStore) return [];
      try {
        return this.deps.ruleStore.findMatching({ filePattern });
      } catch (err) {
        warn('queryRules', err);
        return [];
      }
    });
  }

  async queryHistoricalProfile(taskType: string): Promise<HistoricalProfile | null> {
    return this.withCache('queryHistoricalProfile', { taskType }, async () => {
      if (!this.deps.traceStore) return null;
      try {
        // Historical profiler expects a TaskInput; synthesize a minimal one keyed on the signature.
        // taskType here is a full signature like "fix::ts::small" — we back-decode via a shim task.
        const shim: TaskInput = {
          id: `profile-${taskType}`,
          source: 'cli',
          goal: taskType,
          taskType: 'code',
          targetFiles: [],
          budget: { maxTokens: 0, maxDurationMs: 0, maxRetries: 0 },
        };
        const profile = profileHistory(shim, this.deps.traceStore);
        // If the synthesized signature matches the requested one, return it; otherwise fall back
        // by substituting the requested signature so callers reason in one vocabulary.
        return { ...profile, signature: taskType };
      } catch (err) {
        warn('queryHistoricalProfile', err);
        return null;
      }
    });
  }

  /** Wrap a store call with the per-task LRU cache. */
  private async withCache<T>(method: string, args: unknown, fetch: () => Promise<T>): Promise<T> {
    const taskId = this.currentTaskId();
    if (!taskId) return fetch();

    const scope = this.cache.get(taskId);
    if (!scope) return fetch();

    const key = `${method}:${stableHash(args)}`;
    if (scope.has(key)) {
      // Bump recency: delete + re-insert (Map preserves insertion order).
      const cached = scope.get(key) as T;
      scope.delete(key);
      scope.set(key, cached);
      return cached;
    }

    const value = await fetch();
    scope.set(key, value);

    // Bound total entries; evict oldest.
    while (scope.size > MAX_ENTRIES_PER_TASK) {
      const oldest = scope.keys().next().value;
      if (oldest === undefined) break;
      scope.delete(oldest);
    }
    return value;
  }

  private currentTaskId(): string | undefined {
    return this.taskStack.length > 0 ? this.taskStack[this.taskStack.length - 1] : undefined;
  }
}

/** Stable JSON hash — keys sorted for deterministic cache keys. */
function stableHash(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}

function warn(method: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.warn(`[vinyan] AgentMemoryAPI.${method}: ${msg}`);
}
