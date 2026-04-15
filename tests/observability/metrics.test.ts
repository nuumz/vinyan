import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { PATTERN_SCHEMA_SQL } from '../../src/db/pattern-schema.ts';
import { PatternStore } from '../../src/db/pattern-store.ts';
import { RULE_SCHEMA_SQL } from '../../src/db/rule-schema.ts';
import { RuleStore } from '../../src/db/rule-store.ts';
import { SKILL_SCHEMA_SQL } from '../../src/db/skill-schema.ts';
import { SkillStore } from '../../src/db/skill-store.ts';
import { TRACE_SCHEMA_SQL } from '../../src/db/trace-schema.ts';
import { TraceStore } from '../../src/db/trace-store.ts';
import { getSystemMetrics, type MetricsDeps } from '../../src/observability/metrics.ts';
import type { ExecutionTrace } from '../../src/orchestrator/types.ts';

function createDeps(): MetricsDeps & { db: Database } {
  const db = new Database(':memory:');
  db.exec(TRACE_SCHEMA_SQL);
  db.exec(RULE_SCHEMA_SQL);
  db.exec(SKILL_SCHEMA_SQL);
  db.exec(PATTERN_SCHEMA_SQL);
  return {
    db,
    traceStore: new TraceStore(db),
    ruleStore: new RuleStore(db),
    skillStore: new SkillStore(db),
    patternStore: new PatternStore(db),
  };
}

function insertTrace(store: TraceStore, overrides?: Partial<ExecutionTrace>) {
  store.insert({
    id: `t-${Math.random().toString(36).slice(2)}`,
    taskId: 'task-1',
    timestamp: Date.now(),
    routingLevel: 1,
    taskTypeSignature: 'refactor::foo.ts',
    approach: 'direct',
    oracleVerdicts: { ast: true },
    modelUsed: 'mock',
    tokensConsumed: 100,
    durationMs: 500,
    outcome: 'success',
    affectedFiles: ['foo.ts'],
    qualityScore: {
      architecturalCompliance: 0.9,
      efficiency: 0.8,
      composite: 0.85,
      dimensionsAvailable: 2,
      phase: 'basic',
    },
    ...overrides,
  } as ExecutionTrace);
}

describe('Observability Metrics (P3.6)', () => {
  test('returns zero counts when stores are empty', () => {
    const deps = createDeps();
    const metrics = getSystemMetrics(deps);

    expect(metrics.traces.total).toBe(0);
    expect(metrics.traces.successRate).toBe(0);
    expect(metrics.rules.total).toBe(0);
    expect(metrics.skills.total).toBe(0);
    expect(metrics.patterns.total).toBe(0);
  });

  test('computes correct trace statistics', () => {
    const deps = createDeps();

    // 3 successes, 2 failures
    for (let i = 0; i < 3; i++) insertTrace(deps.traceStore, { id: `s-${i}` });
    for (let i = 0; i < 2; i++) {
      insertTrace(deps.traceStore, {
        id: `f-${i}`,
        outcome: 'failure',
        taskTypeSignature: 'bugfix::bar.ts',
      });
    }

    const metrics = getSystemMetrics(deps);

    expect(metrics.traces.total).toBe(5);
    expect(metrics.traces.distinctTaskTypes).toBe(2);
    expect(metrics.traces.successRate).toBe(0.6);
    expect(metrics.traces.avgQualityComposite).toBeCloseTo(0.85, 1);
    expect(metrics.traces.routingDistribution[1]).toBe(5);
  });

  test('data gates reflect thresholds', () => {
    const deps = createDeps();

    // Not enough traces for sleep cycle gate (needs 100)
    for (let i = 0; i < 10; i++) insertTrace(deps.traceStore, { id: `t-${i}` });

    const metrics = getSystemMetrics(deps);

    expect(metrics.dataGates.sleepCycle).toBe(false);
    expect(metrics.dataGates.skillFormation).toBe(false);
    expect(metrics.dataGates.evolutionEngine).toBe(false);
  });

  test('works with minimal deps (no optional stores)', () => {
    const db = new Database(':memory:');
    db.exec(TRACE_SCHEMA_SQL);
    const traceStore = new TraceStore(db);

    const metrics = getSystemMetrics({ traceStore });

    expect(metrics.rules.total).toBe(0);
    expect(metrics.skills.total).toBe(0);
    expect(metrics.shadow.queueDepth).toBe(0);
  });
});
