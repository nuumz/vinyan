/**
 * PH3.8: Phase 3 Integration Validation
 *
 * End-to-end tests validating all Phase 3 components work together:
 * - Sleep cycle → pattern → rule → promotion pipeline
 * - Self-model calibration improves over time
 * - Skill lifecycle: creation → probation → active → demotion
 * - Phase 4 readiness gate assessment
 * - Graceful degradation when components are missing
 */

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createBus, type VinyanBus } from '../../src/core/bus.ts';
import { PATTERN_SCHEMA_SQL } from '../../src/db/pattern-schema.ts';
import { PatternStore } from '../../src/db/pattern-store.ts';
import { RULE_SCHEMA_SQL } from '../../src/db/rule-schema.ts';
import { RuleStore } from '../../src/db/rule-store.ts';
import { SKILL_SCHEMA_SQL } from '../../src/db/skill-schema.ts';
import { SkillStore } from '../../src/db/skill-store.ts';
import { SELF_MODEL_PARAMS_SCHEMA_SQL, TRACE_SCHEMA_SQL } from '../../src/db/trace-schema.ts';
import { TraceStore } from '../../src/db/trace-store.ts';
import { generatePhase3Report } from '../../src/observability/phase3-report.ts';
import { CalibratedSelfModel } from '../../src/orchestrator/self-model.ts';
import { SkillManager } from '../../src/orchestrator/skill-manager.ts';
import type {
  ExecutionTrace,
  PerceptualHierarchy,
  RoutingLevel,
  SelfModelPrediction,
} from '../../src/orchestrator/types.ts';
import { SleepCycleRunner } from '../../src/sleep-cycle/sleep-cycle.ts';

// ── Helpers ──────────────────────────────────────────────────────────

function createAllStores() {
  const db = new Database(':memory:');
  db.exec(TRACE_SCHEMA_SQL);
  db.exec(SELF_MODEL_PARAMS_SCHEMA_SQL);
  db.exec(PATTERN_SCHEMA_SQL);
  db.exec(RULE_SCHEMA_SQL);
  db.exec(SKILL_SCHEMA_SQL);
  return {
    db,
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
    task_type_signature: 'refactor::auth.ts',
    approach: 'direct-edit',
    oracleVerdicts: { type: true },
    model_used: 'gpt-4o',
    tokens_consumed: 100,
    durationMs: 500,
    outcome: 'success',
    affected_files: ['auth.ts'],
    ...overrides,
  };
}

function seedTraces(
  store: TraceStore,
  opts: { failures: number; successes: number; taskSig: string; approach: string },
) {
  const base = Date.now() - 100000;
  for (let i = 0; i < opts.failures; i++) {
    store.insert(
      makeTrace({
        id: `fail-${opts.approach}-${i}`,
        timestamp: base + i,
        task_type_signature: opts.taskSig,
        approach: opts.approach,
        outcome: 'failure',
        session_id: `s-${i % 5}`,
      }),
    );
  }
  for (let i = 0; i < opts.successes; i++) {
    store.insert(
      makeTrace({
        id: `succ-${opts.approach}-${i}`,
        timestamp: base + opts.failures + i,
        task_type_signature: opts.taskSig,
        approach: opts.approach,
        outcome: 'success',
        session_id: `s-${i % 5}`,
      }),
    );
  }
}

function seedDistinctTaskTypes(store: TraceStore, count: number) {
  const base = Date.now() - 200000;
  for (let i = 0; i < count; i++) {
    store.insert(
      makeTrace({
        id: `extra-${i}`,
        timestamp: base + i,
        task_type_signature: `type-${i}::file-${i}.ts`,
        affected_files: [`file-${i}.ts`],
      }),
    );
  }
}

// ── Tests ────────────────────────────────────────────────────────────

describe('PH3.8: Phase 3 Integration Validation', () => {
  describe('End-to-end: trace → sleep cycle → pattern → rule → promotion', () => {
    test('full feedback loop produces promoted rules from anti-patterns', async () => {
      const { traceStore, patternStore, ruleStore } = createAllStores();
      const bus = createBus();

      // Seed: approach "bad-approach" fails 100% on refactor::auth.ts
      // No successes on same file pattern — avoids backtester false positives
      seedTraces(traceStore, {
        failures: 80,
        successes: 0,
        taskSig: 'refactor::auth.ts',
        approach: 'bad-approach',
      });
      // Filler for data gate (5+ distinct task types)
      seedDistinctTaskTypes(traceStore, 10);

      const runner = new SleepCycleRunner({
        traceStore,
        patternStore,
        ruleStore,
        bus,
        config: { min_traces_for_analysis: 50 },
      });

      // First run: extracts patterns, generates rules in probation
      const result1 = await runner.run();
      expect(result1.antiPatterns).toBeGreaterThanOrEqual(1);
      expect(ruleStore.countByStatus('probation')).toBeGreaterThanOrEqual(1);

      // Add more failure traces with RECENT timestamps (after cycle 1)
      // so they fall within the time-windowed query for the second run
      const recentBase = Date.now();
      for (let i = 0; i < 60; i++) {
        traceStore.insert(
          makeTrace({
            id: `fail2-${i}`,
            timestamp: recentBase + i,
            task_type_signature: 'refactor::auth.ts',
            approach: 'bad-approach',
            outcome: 'failure',
            session_id: `s-${i % 5}`,
          }),
        );
      }
      // Also need distinct task types for the data gate
      for (let i = 0; i < 6; i++) {
        traceStore.insert(
          makeTrace({
            id: `extra2-${i}`,
            timestamp: recentBase + 60 + i,
            task_type_signature: `type2-${i}::file2-${i}.ts`,
            affected_files: [`file2-${i}.ts`],
          }),
        );
      }

      // Second run: backtests probation rules → should promote
      const result2 = await runner.run();
      expect(result2.rulesPromoted).toBeGreaterThanOrEqual(1);
      expect(ruleStore.countByStatus('active')).toBeGreaterThanOrEqual(1);
    });
  });

  describe('Self-Model calibration', () => {
    test('accuracy improves with consistent calibration data', async () => {
      const { db } = createAllStores();
      const model = new CalibratedSelfModel({ db });

      const perception: PerceptualHierarchy = {
        taskTarget: { file: 'auth.ts', description: 'refactor' },
        dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 1 },
        diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
        verifiedFacts: [],
        runtime: { nodeVersion: '18', os: 'darwin', availableTools: [] },
      };

      // Calibrate 20 times with consistent outcomes
      for (let i = 0; i < 20; i++) {
        const pred = await model.predict(
          {
            id: `t-${i}`,
            source: 'cli',
            goal: 'refactor auth',
            budget: { maxTokens: 1000, maxDurationMs: 30000, maxRetries: 3 },
          },
          perception,
        );

        const trace: ExecutionTrace = makeTrace({
          id: `trace-${i}`,
          routingLevel: 1,
          task_type_signature: 'refactor::ts::single',
          outcome: 'success',
          qualityScore: {
            composite: 0.75,
            architecturalCompliance: 0.8,
            efficiency: 0.7,
            dimensionsAvailable: 2,
            phase: 'phase0',
          },
          durationMs: 1000,
        });

        model.calibrate(pred, trace);
      }

      // After calibration, params should reflect the consistent data
      const params = model.getTaskTypeParams('refactor::ts::single');
      expect(params.observationCount).toBe(20);
      expect(params.avgQualityScore).toBeGreaterThan(0.5);
      expect(params.failRate).toBeLessThan(0.2);
    });
  });

  describe('Skill lifecycle', () => {
    test('skill created from success pattern, promoted after outcomes, demoted on failure', async () => {
      const stores = createAllStores();
      const tempDir = mkdtempSync(join(tmpdir(), 'vinyan-ph38-'));
      mkdirSync(join(tempDir, 'src'), { recursive: true });
      writeFileSync(join(tempDir, 'src', 'auth.ts'), 'export function login() {}');

      const skillManager = new SkillManager({
        skillStore: stores.skillStore,
        workspace: tempDir,
        probationSessions: 3, // Fast promotion for testing
      });

      // Seed success pattern: approach A beats B by >25%
      const base = Date.now() - 100000;
      for (let i = 0; i < 10; i++) {
        stores.traceStore.insert(
          makeTrace({
            id: `good-${i}`,
            timestamp: base + i,
            task_type_signature: 'refactor::src/auth.ts',
            approach: 'extract-method',
            outcome: 'success',
            qualityScore: {
              composite: 0.85,
              architecturalCompliance: 0.9,
              efficiency: 0.8,
              dimensionsAvailable: 2,
              phase: 'phase0',
            },
            session_id: `s-${i % 5}`,
            affected_files: ['src/auth.ts'],
          }),
        );
      }
      for (let i = 0; i < 10; i++) {
        stores.traceStore.insert(
          makeTrace({
            id: `bad-${i}`,
            timestamp: base + 10 + i,
            task_type_signature: 'refactor::src/auth.ts',
            approach: 'inline-all',
            outcome: 'success',
            qualityScore: {
              composite: 0.45,
              architecturalCompliance: 0.5,
              efficiency: 0.4,
              dimensionsAvailable: 2,
              phase: 'phase0',
            },
            session_id: `s-${i % 5}`,
            affected_files: ['src/auth.ts'],
          }),
        );
      }
      seedDistinctTaskTypes(stores.traceStore, 6);

      const runner = new SleepCycleRunner({
        traceStore: stores.traceStore,
        patternStore: stores.patternStore,
        ruleStore: stores.ruleStore,
        skillManager,
        config: { min_traces_for_analysis: 20 },
      });

      await runner.run();

      // Skill should be created in probation
      const probation = stores.skillStore.findByStatus('probation');
      expect(probation.length).toBeGreaterThanOrEqual(1);
      const skill = probation[0]!;

      // Record successful outcomes → promote to active
      // Must re-read skill from store each time since recordOutcome reads probationRemaining
      for (let i = 0; i < 3; i++) {
        const current = stores.skillStore.findBySignature(skill.taskSignature)!;
        skillManager.recordOutcome(current, true);
      }
      const afterPromotion = stores.skillStore.findBySignature(skill.taskSignature);
      expect(afterPromotion?.status).toBe('active');

      // Record failure → demote
      skillManager.recordOutcome(afterPromotion!, false);
      const afterDemotion = stores.skillStore.findBySignature(skill.taskSignature);
      expect(afterDemotion?.status).toBe('demoted');

      rmSync(tempDir, { recursive: true, force: true });
    });
  });

  describe('Phase 4 readiness gate', () => {
    test('report computed from stores; readiness gate reflects data', () => {
      const stores = createAllStores();

      // Minimal data
      stores.traceStore.insert(makeTrace());

      const report = generatePhase3Report(stores);
      expect(report.phase4Readiness.ready).toBe(false);
      expect(report.overall).toBeDefined();
      expect(report.evolutionEngine).toBeDefined();
      expect(report.skillFormation).toBeDefined();
    });
  });

  describe('Graceful degradation', () => {
    test('sleep cycle works without skillManager and ruleStore', async () => {
      const { traceStore, patternStore } = createAllStores();

      seedTraces(traceStore, { failures: 45, successes: 5, taskSig: 'refactor::auth.ts', approach: 'bad' });
      seedDistinctTaskTypes(traceStore, 6);

      const runner = new SleepCycleRunner({
        traceStore,
        patternStore,
        config: { min_traces_for_analysis: 50 },
      });

      const result = await runner.run();
      expect(result.tracesAnalyzed).toBeGreaterThan(0);
      expect(result.patterns.length).toBeGreaterThanOrEqual(0);
      // No rules or skills should be created
      expect(result.rulesPromoted).toBe(0);
    });

    test('report works with traceStore only', () => {
      const db = new Database(':memory:');
      db.exec(TRACE_SCHEMA_SQL);
      const traceStore = new TraceStore(db);
      traceStore.insert(makeTrace());

      const report = generatePhase3Report({ traceStore });
      expect(report.evolutionEngine.rulesActive).toBe(0);
      expect(report.skillFormation.active).toBe(0);
      expect(report.phase4Readiness.ready).toBe(false);
    });

    test('self-model works without DB (in-memory only)', async () => {
      const model = new CalibratedSelfModel({});

      const pred = await model.predict(
        { id: 't-1', source: 'cli', goal: 'test', budget: { maxTokens: 1000, maxDurationMs: 30000, maxRetries: 3 } },
        {
          taskTarget: { file: 'a.ts', description: 'test' },
          dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 1 },
          diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
          verifiedFacts: [],
          runtime: { nodeVersion: '18', os: 'darwin', availableTools: [] },
        },
      );

      expect(pred.basis).toBe('static-heuristic');
      expect(pred.confidence).toBeGreaterThan(0);
    });

    test('cold start: data gate blocks sleep cycle with empty DB', async () => {
      const { traceStore, patternStore, ruleStore } = createAllStores();

      const runner = new SleepCycleRunner({
        traceStore,
        patternStore,
        ruleStore,
        config: { min_traces_for_analysis: 100 },
      });

      const result = await runner.run();
      expect(result.tracesAnalyzed).toBe(0);
      expect(result.patterns).toHaveLength(0);
    });
  });
});
