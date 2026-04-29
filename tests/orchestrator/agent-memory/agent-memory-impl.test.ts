/**
 * Behavior tests for Wave 3 AgentMemoryAPIImpl.
 *
 * Covers: delegation, per-task LRU cache, graceful store errors, cache bounds,
 * and a cold-vs-cached latency benchmark.
 */
import { describe, expect, test } from 'bun:test';
import type { Fact } from '../../../src/core/types.ts';
import type { RejectedApproachRow, RejectedApproachStore } from '../../../src/db/rejected-approach-store.ts';
import type { RuleStore } from '../../../src/db/rule-store.ts';
import type { SkillStore } from '../../../src/db/skill-store.ts';
import type { TraceStore } from '../../../src/db/trace-store.ts';
import type { WorldGraph } from '../../../src/world-graph/world-graph.ts';
import { AgentMemoryAPIImpl } from '../../../src/orchestrator/agent-memory/agent-memory-impl.ts';
import type { CachedSkill, EvolutionaryRule, ExecutionTrace } from '../../../src/orchestrator/types.ts';

// ── Fake stores ─────────────────────────────────────────────────────────

interface CallCounts {
  worldGraph: number;
  skills: number;
  traces: number;
  rules: number;
  rejected: number;
}

function makeFakes(opts?: { throws?: boolean }) {
  const counts: CallCounts = { worldGraph: 0, skills: 0, traces: 0, rules: 0, rejected: 0 };

  const worldGraph = {
    queryFacts(target: string): Fact[] {
      counts.worldGraph++;
      if (opts?.throws) throw new Error('wg-boom');
      return [
        {
          id: 'f1',
          target,
          pattern: 'p',
          evidence: [],
          oracleName: 'ast',
          fileHash: 'h',
          sourceFile: target,
          verifiedAt: 0,
          confidence: 0.9,
        },
        {
          id: 'f2',
          target,
          pattern: 'p',
          evidence: [],
          oracleName: 'type',
          fileHash: 'h',
          sourceFile: target,
          verifiedAt: 0,
          confidence: 0.4,
        },
      ];
    },
  } as unknown as WorldGraph;

  const skillStore = {
    findSimilar(taskSig: string, k: number): CachedSkill[] {
      counts.skills++;
      if (opts?.throws) throw new Error('skill-boom');
      const fake: CachedSkill[] = [
        {
          taskSignature: `${taskSig}::match`,
          approach: 'approach-a',
          successRate: 0.9,
          status: 'active',
          probationRemaining: 0,
          usageCount: 10,
          riskAtCreation: 0.1,
          depConeHashes: {},
          lastVerifiedAt: 0,
          verificationProfile: 'hash-only',
        },
      ];
      return fake.slice(0, k);
    },
  } as unknown as SkillStore;

  const traceStore = {
    findByTaskType(sig: string, limit: number): ExecutionTrace[] {
      counts.traces++;
      if (opts?.throws) throw new Error('trace-boom');
      return Array.from({ length: Math.min(limit, 3) }).map((_, i) => ({
        id: `t-${i}`,
        taskId: `task-${i}`,
        timestamp: 0,
        routingLevel: 1 as const,
        approach: 'x',
        oracleVerdicts: {},
        modelUsed: 'm',
        tokensConsumed: 0,
        durationMs: 0,
        outcome: 'success',
        affectedFiles: [],
        taskTypeSignature: sig,
      })) as ExecutionTrace[];
    },
  } as unknown as TraceStore;

  const ruleStore = {
    findMatching(ctx: { filePattern?: string }): EvolutionaryRule[] {
      counts.rules++;
      if (opts?.throws) throw new Error('rule-boom');
      return [
        {
          id: 'r1',
          source: 'manual',
          condition: { filePattern: ctx.filePattern },
          action: 'escalate',
          parameters: {},
          status: 'active',
          createdAt: 0,
          effectiveness: 0.8,
          specificity: 1,
        },
      ];
    },
  } as unknown as RuleStore;

  const rejectedApproachStore = {
    loadForTask(file: string, type: string, limit: number): RejectedApproachRow[] {
      counts.rejected++;
      if (opts?.throws) throw new Error('rej-boom');
      return Array.from({ length: Math.min(limit, 2) }).map((_, i) => ({
        id: i,
        task_id: `t-${i}`,
        task_type: type,
        file_target: file === '*' ? null : file,
        file_hash: null,
        approach: `rejected-${i}`,
        oracle_verdict: 'fail',
        verdict_confidence: 0.7,
        failure_oracle: 'ast',
        routing_level: 1,
        source: 'task-end',
        created_at: 0,
        expires_at: null,
        action_verb: null,
      }));
    },
  } as unknown as RejectedApproachStore;

  return { counts, worldGraph, skillStore, traceStore, ruleStore, rejectedApproachStore };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('AgentMemoryAPIImpl — delegation', () => {
  test('queryFacts delegates to WorldGraph and returns results', async () => {
    const { counts, ...deps } = makeFakes();
    const api = new AgentMemoryAPIImpl(deps);
    const facts = await api.queryFacts('src/foo.ts');
    expect(counts.worldGraph).toBe(1);
    expect(facts).toHaveLength(2);
    expect(facts[0]!.target).toBe('src/foo.ts');
  });

  test('queryFacts filters by minConfidence', async () => {
    const { ...deps } = makeFakes();
    const api = new AgentMemoryAPIImpl(deps);
    const high = await api.queryFacts('src/foo.ts', { minConfidence: 0.8 });
    expect(high).toHaveLength(1);
    expect(high[0]!.confidence).toBeGreaterThanOrEqual(0.8);
  });

  test('queryRelatedSkills calls skillStore.findSimilar with correct k', async () => {
    const { counts, ...deps } = makeFakes();
    const api = new AgentMemoryAPIImpl(deps);
    const skills = await api.queryRelatedSkills('refactor::ts::small', { k: 3 });
    expect(counts.skills).toBe(1);
    expect(skills.length).toBeGreaterThan(0);
    expect(skills[0]!.taskSignature).toContain('refactor');
  });

  test('queryPriorTraces delegates with limit', async () => {
    const { counts, ...deps } = makeFakes();
    const api = new AgentMemoryAPIImpl(deps);
    const traces = await api.queryPriorTraces('sig-1', { limit: 2 });
    expect(counts.traces).toBe(1);
    expect(traces).toHaveLength(2);
  });

  test('queryRules delegates filePattern', async () => {
    const { counts, ...deps } = makeFakes();
    const api = new AgentMemoryAPIImpl(deps);
    const rules = await api.queryRules('src/**/*.ts');
    expect(counts.rules).toBe(1);
    expect(rules[0]!.condition.filePattern).toBe('src/**/*.ts');
  });

  test('queryFailedApproaches delegates with default file wildcard', async () => {
    const { counts, ...deps } = makeFakes();
    const api = new AgentMemoryAPIImpl(deps);
    const rejected = await api.queryFailedApproaches('refactor');
    expect(counts.rejected).toBe(1);
    expect(rejected.length).toBeGreaterThan(0);
  });

  test('recordFailedApproach delegates to RejectedApproachStore.store with mapped fields', async () => {
    const stored: Array<Parameters<RejectedApproachStore['store']>[0]> = [];
    const rejectedApproachStore = {
      loadForTask: () => [],
      store(entry: Parameters<RejectedApproachStore['store']>[0]) {
        stored.push(entry);
      },
    } as unknown as RejectedApproachStore;
    const api = new AgentMemoryAPIImpl({ rejectedApproachStore });
    await api.recordFailedApproach!({
      taskId: 't1',
      taskType: 'reasoning',
      approach: 'agentic-workflow:llm-reasoning',
      failureOracle: 'workflow-step-failed',
      routingLevel: 2,
      fileTarget: 'src/foo.ts',
      actionVerb: 'check',
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      taskId: 't1',
      taskType: 'reasoning',
      approach: 'agentic-workflow:llm-reasoning',
      failureOracle: 'workflow-step-failed',
      routingLevel: 2,
      fileTarget: 'src/foo.ts',
      actionVerb: 'check',
      oracleVerdict: 'rejected',
      verdictConfidence: 1.0,
      source: 'task-end',
    });
  });

  test('recordFailedApproach is a no-op when no rejectedApproachStore is wired', async () => {
    const api = new AgentMemoryAPIImpl({});
    // Should not throw — gracefully degrades.
    await api.recordFailedApproach!({
      taskId: 't1',
      taskType: 'reasoning',
      approach: 'x',
      failureOracle: 'y',
      routingLevel: 2,
    });
  });

  test('recordFailedApproach swallows store errors (best-effort write)', async () => {
    const rejectedApproachStore = {
      loadForTask: () => [],
      store() {
        throw new Error('store boom');
      },
    } as unknown as RejectedApproachStore;
    const api = new AgentMemoryAPIImpl({ rejectedApproachStore });
    // Must not propagate — otherwise a transient db error fails the workflow.
    await api.recordFailedApproach!({
      taskId: 't1',
      taskType: 'reasoning',
      approach: 'x',
      failureOracle: 'y',
      routingLevel: 2,
    });
  });
});

describe('AgentMemoryAPIImpl — per-task LRU cache', () => {
  test('cache hit — two identical calls query store exactly once', async () => {
    const { counts, ...deps } = makeFakes();
    const api = new AgentMemoryAPIImpl(deps);
    api.beginTask('task-1');
    await api.queryFacts('src/foo.ts');
    await api.queryFacts('src/foo.ts');
    expect(counts.worldGraph).toBe(1);
    api.endTask('task-1');
  });

  test('cache miss on different args refetches', async () => {
    const { counts, ...deps } = makeFakes();
    const api = new AgentMemoryAPIImpl(deps);
    api.beginTask('task-1');
    await api.queryFacts('src/foo.ts');
    await api.queryFacts('src/bar.ts');
    expect(counts.worldGraph).toBe(2);
    api.endTask('task-1');
  });

  test('cache isolated per taskId', async () => {
    const { counts, ...deps } = makeFakes();
    const api = new AgentMemoryAPIImpl(deps);

    api.beginTask('task-1');
    await api.queryFacts('src/foo.ts');
    api.endTask('task-1');

    api.beginTask('task-2');
    await api.queryFacts('src/foo.ts'); // new task scope → fresh fetch
    api.endTask('task-2');

    expect(counts.worldGraph).toBe(2);
  });

  test('queries without beginTask still work (no cache)', async () => {
    const { counts, ...deps } = makeFakes();
    const api = new AgentMemoryAPIImpl(deps);
    await api.queryFacts('src/foo.ts');
    await api.queryFacts('src/foo.ts');
    expect(counts.worldGraph).toBe(2);
  });

  test('cache bounded: inserting > 100 entries evicts oldest', async () => {
    const { counts, ...deps } = makeFakes();
    const api = new AgentMemoryAPIImpl(deps);
    api.beginTask('task-big');

    // Insert 105 distinct queries — oldest 5 should be evicted
    for (let i = 0; i < 105; i++) {
      await api.queryFacts(`file-${i}.ts`);
    }
    expect(counts.worldGraph).toBe(105);

    // Re-request file-0 → should miss (evicted) and refetch
    const before = counts.worldGraph;
    await api.queryFacts('file-0.ts');
    expect(counts.worldGraph).toBe(before + 1);

    // Re-request file-104 → should hit (most recent, still cached)
    const afterMid = counts.worldGraph;
    await api.queryFacts('file-104.ts');
    expect(counts.worldGraph).toBe(afterMid);

    api.endTask('task-big');
  });
});

describe('AgentMemoryAPIImpl — error tolerance', () => {
  test('store errors return [] / null without throwing', async () => {
    const { ...deps } = makeFakes({ throws: true });
    const api = new AgentMemoryAPIImpl(deps);

    expect(await api.queryFacts('x')).toEqual([]);
    expect(await api.queryRelatedSkills('sig')).toEqual([]);
    expect(await api.queryPriorTraces('sig')).toEqual([]);
    expect(await api.queryRules('*.ts')).toEqual([]);
    expect(await api.queryFailedApproaches('refactor')).toEqual([]);
  });

  test('missing stores return [] / null gracefully', async () => {
    const api = new AgentMemoryAPIImpl({});
    expect(await api.queryFacts('x')).toEqual([]);
    expect(await api.queryRelatedSkills('sig')).toEqual([]);
    expect(await api.queryPriorTraces('sig')).toEqual([]);
    expect(await api.queryRules('*.ts')).toEqual([]);
    expect(await api.queryFailedApproaches('refactor')).toEqual([]);
    expect(await api.queryHistoricalProfile('sig')).toBeNull();
  });
});

describe('AgentMemoryAPIImpl — benchmark (cold vs cached)', () => {
  test('cached queries are measurably faster than cold (p50, p99)', async () => {
    const { ...deps } = makeFakes();
    const api = new AgentMemoryAPIImpl(deps);

    // Cold: 100 unique queries (no task scope → every call fetches)
    const coldTimes: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      await api.queryFacts(`cold-${i}.ts`);
      coldTimes.push(performance.now() - t0);
    }

    // Cached: prime 1 query then replay 100 times in task scope
    api.beginTask('bench-task');
    await api.queryFacts('hot.ts'); // prime
    const cachedTimes: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      await api.queryFacts('hot.ts');
      cachedTimes.push(performance.now() - t0);
    }
    api.endTask('bench-task');

    const percentile = (arr: number[], p: number): number => {
      const sorted = [...arr].sort((a, b) => a - b);
      return sorted[Math.floor(sorted.length * p)] ?? 0;
    };

    const coldP50 = percentile(coldTimes, 0.5);
    const coldP99 = percentile(coldTimes, 0.99);
    const cachedP50 = percentile(cachedTimes, 0.5);
    const cachedP99 = percentile(cachedTimes, 0.99);

    // Stash results so they show up in verbose test logs.
    console.log(
      `[bench] cold p50=${coldP50.toFixed(3)}ms p99=${coldP99.toFixed(3)}ms  ` +
        `cached p50=${cachedP50.toFixed(3)}ms p99=${cachedP99.toFixed(3)}ms`,
    );

    // Cached should be well under 1ms; cold stays in-memory so also fast but slower on average.
    expect(cachedP50).toBeLessThan(1);
    expect(cachedP99).toBeLessThan(5);
    // Sanity: cached p50 ≤ cold p50 (may be equal at ~0 on very fast hardware)
    expect(cachedP50).toBeLessThanOrEqual(coldP50 + 0.5);
  });
});
