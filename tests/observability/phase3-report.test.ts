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
import { computeQualityTrend, generateEvolutionReport } from '../../src/observability/phase3-report.ts';
import type { CachedSkill, EvolutionaryRule, ExecutionTrace } from '../../src/orchestrator/types.ts';

function createAllStores() {
  const db = new Database(':memory:');
  db.exec(TRACE_SCHEMA_SQL);
  db.exec(PATTERN_SCHEMA_SQL);
  db.exec(RULE_SCHEMA_SQL);
  db.exec(SKILL_SCHEMA_SQL);
  return {
    traceStore: new TraceStore(db),
    patternStore: new PatternStore(db),
    ruleStore: new RuleStore(db),
    skillStore: new SkillStore(db),
  };
}

function makeTrace(overrides?: Partial<ExecutionTrace>): ExecutionTrace {
  return {
    id: `t-${Math.random().toString(36).slice(2)}`,
    taskId: `task-${Math.random().toString(36).slice(2)}`,
    timestamp: Date.now(),
    routingLevel: 1,
    approach: 'default',
    oracleVerdicts: { type: true },
    modelUsed: 'gpt-4o',
    tokensConsumed: 100,
    durationMs: 500,
    outcome: 'success',
    affectedFiles: ['a.ts'],
    ...overrides,
  };
}

function makeRule(overrides?: Partial<EvolutionaryRule>): EvolutionaryRule {
  return {
    id: `rule-${Math.random().toString(36).slice(2)}`,
    source: 'sleep-cycle',
    condition: { filePattern: '*.ts' },
    action: 'escalate',
    parameters: { toLevel: 2 },
    status: 'active',
    createdAt: Date.now(),
    effectiveness: 0.6,
    specificity: 1,
    ...overrides,
  };
}

function makeSkill(overrides?: Partial<CachedSkill>): CachedSkill {
  return {
    taskSignature: `refactor::ts::${Math.random().toString(36).slice(2)}`,
    approach: 'extract-method',
    successRate: 0.85,
    status: 'active',
    probationRemaining: 0,
    usageCount: 5,
    riskAtCreation: 0.1,
    depConeHashes: {},
    lastVerifiedAt: Date.now(),
    verificationProfile: 'hash-only',
    ...overrides,
  };
}

describe('PH3.7: Phase 3 Report', () => {
  describe('computeQualityTrend', () => {
    test('positive trend for improving scores', () => {
      const scores = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
      const trend = computeQualityTrend(scores);
      expect(trend).toBeGreaterThan(0);
    });

    test('negative trend for degrading scores', () => {
      const scores = [0.8, 0.7, 0.6, 0.5, 0.4, 0.3];
      const trend = computeQualityTrend(scores);
      expect(trend).toBeLessThan(0);
    });

    test('flat trend for constant scores', () => {
      const scores = [0.5, 0.5, 0.5, 0.5];
      const trend = computeQualityTrend(scores);
      expect(trend).toBeCloseTo(0, 5);
    });

    test('returns 0 for empty or single-element array', () => {
      expect(computeQualityTrend([])).toBe(0);
      expect(computeQualityTrend([0.5])).toBe(0);
    });
  });

  describe('generateEvolutionReport', () => {
    test('returns all metric fields with populated stores', () => {
      const stores = createAllStores();

      // Insert traces
      for (let i = 0; i < 10; i++) {
        stores.traceStore.insert(
          makeTrace({
            qualityScore: {
              composite: 0.5 + i * 0.03,
              architecturalCompliance: 0.7,
              efficiency: 0.6,
              dimensionsAvailable: 2,
              phase: 'basic',
            },
          }),
        );
      }

      // Insert rules
      stores.ruleStore.insert(makeRule({ id: 'r1', effectiveness: 0.5 }));
      stores.ruleStore.insert(makeRule({ id: 'r2', effectiveness: 0.2, status: 'retired' }));

      // Insert skills
      stores.skillStore.insert(makeSkill({ taskSignature: 'refactor::ts::a', successRate: 0.9 }));

      const report = generateEvolutionReport(stores);

      expect(report.evolutionEngine.rulesActive).toBe(1);
      expect(report.evolutionEngine.rulesRetired).toBe(1);
      expect(report.skillFormation.active).toBe(1);
      expect(report.overall.qualityTrend).toBeGreaterThan(0);
    });

    test('routing efficiency computed correctly', () => {
      const stores = createAllStores();

      // 3 tasks: 2 resolved at initial level, 1 escalated
      stores.traceStore.insert(makeTrace({ taskId: 't1', routingLevel: 1, outcome: 'success' }));
      stores.traceStore.insert(makeTrace({ taskId: 't2', routingLevel: 1, outcome: 'success' }));
      stores.traceStore.insert(makeTrace({ taskId: 't3', routingLevel: 1, outcome: 'escalated' }));

      const report = generateEvolutionReport(stores);
      // t1 and t2 resolved at initial, t3 escalated
      expect(report.overall.routingEfficiency).toBeCloseTo(2 / 3, 2);
      expect(report.overall.escalationRate).toBeCloseTo(1 / 3, 2);
    });

    test('works with minimal deps (traceStore only)', () => {
      const db = new Database(':memory:');
      db.exec(TRACE_SCHEMA_SQL);
      const traceStore = new TraceStore(db);
      traceStore.insert(makeTrace());

      const report = generateEvolutionReport({ traceStore });
      expect(report.evolutionEngine.rulesActive).toBe(0);
      expect(report.skillFormation.active).toBe(0);
    });
  });

  describe('Phase 4 Readiness Gate', () => {
    test('not ready when conditions are not met', () => {
      const stores = createAllStores();
      stores.traceStore.insert(makeTrace());

      const report = generateEvolutionReport(stores);
      expect(report.phase4Readiness.ready).toBe(false);
    });

    test('all conditions checked individually', () => {
      const stores = createAllStores();
      stores.traceStore.insert(makeTrace());

      const report = generateEvolutionReport(stores);
      const conds = report.phase4Readiness.conditions;

      expect(conds.activeRulesEffective.threshold).toBe(3);
      expect(conds.activeSkillsHighPerf.threshold).toBe(2);
      expect(conds.globalAccuracy.threshold).toBe(0.7);
      expect(conds.sleepCycles.threshold).toBe(10);
    });

    test('ready when all conditions met', () => {
      const stores = createAllStores();

      // Rules with high effectiveness
      for (let i = 0; i < 4; i++) {
        stores.ruleStore.insert(makeRule({ id: `r-${i}`, effectiveness: 0.5 }));
      }

      // High-perf skills
      stores.skillStore.insert(makeSkill({ taskSignature: 'a::ts::s', successRate: 0.9 }));
      stores.skillStore.insert(makeSkill({ taskSignature: 'b::ts::s', successRate: 0.8 }));

      // Enough sleep cycles
      for (let i = 0; i < 10; i++) {
        stores.patternStore.recordCycleStart(`c-${i}`);
        stores.patternStore.recordCycleComplete(`c-${i}`, 100, 5);
      }

      // Traces with prediction errors showing good accuracy
      for (let i = 0; i < 20; i++) {
        stores.traceStore.insert(
          makeTrace({
            predictionError: {
              taskId: `t-${i}`,
              predicted: {} as any,
              actual: {} as any,
              error: {
                testResultMatch: true,
                blastRadiusDelta: 0,
                durationDelta: 0,
                qualityScoreDelta: 0.1,
                composite: 0.1,
              },
            },
          }),
        );
      }

      const report = generateEvolutionReport(stores);
      expect(report.phase4Readiness.conditions.activeRulesEffective.met).toBe(true);
      expect(report.phase4Readiness.conditions.activeSkillsHighPerf.met).toBe(true);
      expect(report.phase4Readiness.conditions.sleepCycles.met).toBe(true);
      expect(report.phase4Readiness.conditions.globalAccuracy.met).toBe(true);
      expect(report.phase4Readiness.ready).toBe(true);
    });
  });
});
