/**
 * Knowledge Sharing Wiring tests — PH5.9.
 *
 * Tests the end-to-end wiring of:
 * 1. KnowledgeExchangeManager → PatternStore persistence
 * 2. exportFromStore / buildTransfer methods
 * 3. CalibratedSelfModel.warmStartFromPeer
 * 4. CapabilityManager → OracleProfileStore (probation on peer oracle)
 * 5. I14: imported knowledge enters probation (50% confidence reduction)
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { CalibrationExchange, type CalibrationReport } from '../../src/a2a/calibration.ts';
import { CapabilityManager } from '../../src/a2a/capability-updates.ts';
import { KnowledgeExchangeManager } from '../../src/a2a/knowledge-exchange.ts';
import { EventBus, type VinyanBusEvents } from '../../src/core/bus.ts';
import { migration005 } from '../../src/db/migrations/005_add_oracle_profiles.ts';
import { OracleProfileStore } from '../../src/db/oracle-profile-store.ts';
import { PatternStore } from '../../src/db/pattern-store.ts';
import type { AbstractPattern } from '../../src/evolution/pattern-abstraction.ts';
import { CalibratedSelfModel } from '../../src/orchestrator/prediction/self-model.ts';

function createDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  // Create extracted_patterns table
  db.exec(`CREATE TABLE IF NOT EXISTS extracted_patterns (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    description TEXT NOT NULL,
    frequency INTEGER NOT NULL,
    confidence REAL NOT NULL,
    task_type_signature TEXT,
    approach TEXT,
    compared_approach TEXT,
    quality_delta REAL,
    source_trace_ids TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL,
    expires_at INTEGER,
    decay_weight REAL NOT NULL DEFAULT 1.0,
    derived_from TEXT,
    routing_level INTEGER,
    model_pattern TEXT,
    worker_id TEXT,
    compared_worker_id TEXT
  )`);
  // Create sleep_cycle_runs table (needed by PatternStore)
  db.exec(`CREATE TABLE IF NOT EXISTS sleep_cycle_runs (
    id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    completed_at INTEGER,
    traces_analyzed INTEGER DEFAULT 0,
    patterns_extracted INTEGER DEFAULT 0
  )`);
  return db;
}

function makeBus(): EventBus<VinyanBusEvents> {
  return new EventBus<VinyanBusEvents>();
}

function makeAbstractPattern(overrides: Partial<AbstractPattern> = {}): AbstractPattern {
  return {
    fingerprint: {
      actionVerb: 'modify',
      fileExtensions: ['ts'],
      blastRadiusBucket: 'small',
      frameworkMarkers: [],
    },
    approach: 'refactor imports',
    qualityRange: { min: 0.6, max: 0.8 },
    confidence: 0.75,
    sourceProjectId: 'proj-remote',
    sourcePatternIds: ['pat-remote-001'],
    applicabilityConditions: {
      frameworkMarkers: [],
      languageMarkers: ['typescript'],
      complexityRange: ['small'],
    },
    type: 'anti-pattern',
    description: 'test abstract pattern',
    exportedAt: Date.now(),
    ...overrides,
  };
}

const targetMarkers = { frameworks: [], languages: ['ts'] };

describe('KnowledgeExchangeManager — PatternStore persistence', () => {
  test('importPatterns persists to pattern store', () => {
    const bus = makeBus();
    const db = createDb();
    const patternStore = new PatternStore(db);

    const mgr = new KnowledgeExchangeManager({
      bus,
      projectId: 'proj-local',
      instanceId: 'inst-001',
      targetMarkers,
      patternStore,
    });

    const abstract = makeAbstractPattern({ confidence: 0.8 });
    const imported = mgr.importPatterns({ patterns: [abstract] }, 'peer-remote');

    expect(imported).toHaveLength(1);

    // Verify persisted to store
    const stored = patternStore.findActive(0);
    expect(stored.length).toBeGreaterThanOrEqual(1);
    const found = stored.find((p) => p.id === imported[0]!.id);
    expect(found).not.toBeUndefined();
    expect(found!.confidence).toBe(0.4); // 0.8 * 0.5 = 0.4 (I14: 50% reduction)
  });

  test('I14: imported patterns enter with halved confidence (probation)', () => {
    const bus = makeBus();
    const db = createDb();
    const patternStore = new PatternStore(db);

    const mgr = new KnowledgeExchangeManager({
      bus,
      projectId: 'proj-local',
      instanceId: 'inst-001',
      targetMarkers,
      patternStore,
    });

    const abstract = makeAbstractPattern({ confidence: 1.0 });
    const imported = mgr.importPatterns({ patterns: [abstract] }, 'peer-1');

    // Confidence should be exactly halved
    expect(imported[0]!.confidence).toBe(0.5);
    expect(imported[0]!.description).toContain('[imported]');
  });

  test('importPatterns without store still returns patterns', () => {
    const bus = makeBus();
    const mgr = new KnowledgeExchangeManager({
      bus,
      projectId: 'proj-local',
      instanceId: 'inst-001',
      targetMarkers,
      // No patternStore
    });

    const abstract = makeAbstractPattern();
    const imported = mgr.importPatterns({ patterns: [abstract] }, 'peer-1');
    expect(imported).toHaveLength(1);
  });
});

describe('KnowledgeExchangeManager — exportFromStore', () => {
  test('exports high-confidence patterns from store', () => {
    const bus = makeBus();
    const db = createDb();
    const patternStore = new PatternStore(db);

    // Insert a high-confidence pattern (use dotted extensions for language marker extraction)
    patternStore.insert({
      id: 'pat-high',
      type: 'success-pattern',
      description: 'good pattern',
      frequency: 10,
      confidence: 0.85,
      taskTypeSignature: 'modify::.ts::small',
      approach: 'refactor',
      sourceTraceIds: ['t1'],
      createdAt: Date.now(),
      decayWeight: 1.0,
    });

    const mgr = new KnowledgeExchangeManager({
      bus,
      projectId: 'proj-local',
      instanceId: 'inst-001',
      targetMarkers,
      patternStore,
    });

    const offer = mgr.exportFromStore(0.7);
    expect(offer).not.toBeNull();
    expect(offer!.patterns.length).toBeGreaterThanOrEqual(1);
  });

  test('returns null when no high-confidence patterns', () => {
    const bus = makeBus();
    const db = createDb();
    const patternStore = new PatternStore(db);

    // Insert only a low-confidence pattern
    patternStore.insert({
      id: 'pat-low',
      type: 'anti-pattern',
      description: 'weak pattern',
      frequency: 3,
      confidence: 0.3,
      taskTypeSignature: 'modify::py::small',
      approach: 'bad approach',
      sourceTraceIds: ['t1'],
      createdAt: Date.now(),
      decayWeight: 1.0,
    });

    const mgr = new KnowledgeExchangeManager({
      bus,
      projectId: 'proj-local',
      instanceId: 'inst-001',
      targetMarkers,
      patternStore,
    });

    const offer = mgr.exportFromStore(0.7);
    expect(offer).toBeNull();
  });

  test('returns null without pattern store', () => {
    const bus = makeBus();
    const mgr = new KnowledgeExchangeManager({
      bus,
      projectId: 'proj-local',
      instanceId: 'inst-001',
      targetMarkers,
    });

    const offer = mgr.exportFromStore();
    expect(offer).toBeNull();
  });
});

describe('KnowledgeExchangeManager — buildTransfer', () => {
  test('builds transfer payload from patterns', () => {
    const bus = makeBus();
    const mgr = new KnowledgeExchangeManager({
      bus,
      projectId: 'proj-local',
      instanceId: 'inst-001',
      targetMarkers,
    });

    const transfer = mgr.buildTransfer([
      {
        id: 'pat-001',
        type: 'success-pattern',
        description: 'good pattern',
        frequency: 10,
        confidence: 0.8,
        taskTypeSignature: 'modify::.ts::small',
        approach: 'refactor',
        sourceTraceIds: ['t1'],
        createdAt: Date.now(),
        decayWeight: 1.0,
      },
    ]);

    expect(transfer.patterns).toHaveLength(1);
    expect(transfer.patterns[0]!.sourceProjectId).toBe('proj-local');
  });
});

describe('CalibratedSelfModel — warmStartFromPeer', () => {
  test('warm-starts unseen task types from peer calibration', () => {
    const selfModel = new CalibratedSelfModel();

    const report: CalibrationReport = {
      instance_id: 'peer-1',
      per_task_type: {
        'modify::ts::small': { brier_score: 0.15, wilson_lb: 0.72, sample_size: 50, bias_direction: 'calibrated' },
        'fix::py::medium': { brier_score: 0.2, wilson_lb: 0.68, sample_size: 30, bias_direction: 'underconfident' },
      },
      overall_accuracy_ema: 0.85,
      report_timestamp: Date.now(),
    };

    const applied = selfModel.warmStartFromPeer(report);
    expect(applied).toBe(2);

    // Verify parameters are warm-started
    const params = selfModel.getTaskTypeParams('modify::ts::small');
    expect(params.observationCount).toBeGreaterThan(0);
    expect(params.basis).toBe('static-heuristic'); // Peer data never trace-calibrated
  });

  test('skips task types that already have local data', () => {
    const db = new Database(':memory:');
    const selfModel = new CalibratedSelfModel({ db });

    // Manually set up a task type with some observations
    const first = selfModel.getTaskTypeParams('modify::ts::small');
    // Calibrate once to create local data
    selfModel.calibrate(
      {
        taskId: 't1',
        timestamp: Date.now(),
        expectedTestResults: 'pass',
        expectedBlastRadius: 1,
        expectedDuration: 1000,
        expectedQualityScore: 0.7,
        uncertainAreas: [],
        confidence: 0.5,
        metaConfidence: 0.1,
        basis: 'static-heuristic',
        calibrationDataPoints: 0,
      },
      {
        id: 'trace-1',
        taskId: 't1',
        timestamp: Date.now(),
        routingLevel: 1,
        approach: 'test',
        modelUsed: 'mock/test',
        tokensConsumed: 100,
        durationMs: 500,
        outcome: 'success',
        oracleVerdicts: {},
        affectedFiles: ['test.ts'],
        taskTypeSignature: 'modify::ts::small',
      },
    );

    const report: CalibrationReport = {
      instance_id: 'peer-1',
      per_task_type: {
        'modify::ts::small': { brier_score: 0.1, wilson_lb: 0.9, sample_size: 100, bias_direction: 'calibrated' },
        'new::go::large': { brier_score: 0.2, wilson_lb: 0.7, sample_size: 40, bias_direction: 'calibrated' },
      },
      overall_accuracy_ema: 0.9,
      report_timestamp: Date.now(),
    };

    const applied = selfModel.warmStartFromPeer(report);
    expect(applied).toBe(1); // Only new::go::large, not modify::ts::small
  });

  test('reduced peer weight (default 0.25)', () => {
    const selfModel = new CalibratedSelfModel();

    const report: CalibrationReport = {
      instance_id: 'peer-1',
      per_task_type: {
        'add::rs::small': { brier_score: 0.1, wilson_lb: 0.9, sample_size: 100, bias_direction: 'calibrated' },
      },
      overall_accuracy_ema: 0.95,
      report_timestamp: Date.now(),
    };

    selfModel.warmStartFromPeer(report, 0.25);

    const params = selfModel.getTaskTypeParams('add::rs::small');
    // observation count should be sample_size * weight = 100 * 0.25 = 25
    expect(params.observationCount).toBe(25);
    // accuracy should be wilson_lb * weight = 0.9 * 0.25 = 0.225
    expect(params.predictionAccuracy).toBeCloseTo(0.225, 2);
  });
});

describe('CalibrationExchange — self-model integration', () => {
  test('handleReport feeds calibration to self-model', () => {
    const selfModel = new CalibratedSelfModel();

    const exchange = new CalibrationExchange({
      instanceId: 'inst-001',
      selfModel,
    });

    const report: CalibrationReport = {
      instance_id: 'peer-1',
      per_task_type: {
        'debug::ts::medium': { brier_score: 0.15, wilson_lb: 0.7, sample_size: 40, bias_direction: 'calibrated' },
      },
      overall_accuracy_ema: 0.85,
      report_timestamp: Date.now(),
    };

    exchange.handleReport('peer-1', report);

    // Self-model should have warm-started the task type
    const params = selfModel.getTaskTypeParams('debug::ts::medium');
    expect(params.observationCount).toBeGreaterThan(0);
  });

  test('discounted peers are not fed to self-model', () => {
    const selfModel = new CalibratedSelfModel();

    const exchange = new CalibrationExchange({
      instanceId: 'inst-001',
      selfModel,
      discountThreshold: 0.2,
    });

    // First: register a poorly-calibrated peer
    exchange.handleReport('bad-peer', {
      instance_id: 'bad-peer',
      per_task_type: {
        'add::ts::small': { brier_score: 0.5, wilson_lb: 0.3, sample_size: 10, bias_direction: 'overconfident' },
      },
      overall_accuracy_ema: 0.4,
      report_timestamp: Date.now(),
    });

    // Now send another report — peer should be discounted
    exchange.handleReport('bad-peer', {
      instance_id: 'bad-peer',
      per_task_type: {
        'new-task::py::large': { brier_score: 0.5, wilson_lb: 0.3, sample_size: 20, bias_direction: 'overconfident' },
      },
      overall_accuracy_ema: 0.4,
      report_timestamp: Date.now(),
    });

    // The second report's task type should NOT be warm-started since peer was already known-bad
    // (Note: first report's task types may have been warm-started before discount was known)
    const params = selfModel.getTaskTypeParams('new-task::py::large');
    expect(params.observationCount).toBe(0);
  });
});

describe('CapabilityManager — oracle profile creation', () => {
  test('creates oracle profile in probation when peer adds oracle', () => {
    const db = new Database(':memory:');
    migration005.up(db);
    const profileStore = new OracleProfileStore(db);

    const capMgr = new CapabilityManager({
      instanceId: 'local-1',
      peerUrls: [],
      oracleProfileStore: profileStore,
    });

    capMgr.handleUpdate('peer-1', {
      instance_id: 'peer-1',
      capability_version: 1,
      update_type: 'oracle_added',
      delta: { oracle_name: 'type-oracle', action: 'added' },
      timestamp: Date.now(),
    });

    const profile = profileStore.getProfile('peer-1', 'type-oracle');
    expect(profile).not.toBeNull();
    expect(profile!.status).toBe('probation');
  });

  test('does not duplicate oracle profile on repeated updates', () => {
    const db = new Database(':memory:');
    migration005.up(db);
    const profileStore = new OracleProfileStore(db);

    const capMgr = new CapabilityManager({
      instanceId: 'local-1',
      peerUrls: [],
      oracleProfileStore: profileStore,
    });

    capMgr.handleUpdate('peer-1', {
      instance_id: 'peer-1',
      capability_version: 1,
      update_type: 'oracle_added',
      delta: { oracle_name: 'type-oracle', action: 'added' },
      timestamp: Date.now(),
    });

    capMgr.handleUpdate('peer-1', {
      instance_id: 'peer-1',
      capability_version: 2,
      update_type: 'oracle_added',
      delta: { oracle_name: 'type-oracle', action: 'added' },
      timestamp: Date.now(),
    });

    const profiles = profileStore.getProfilesByInstance('peer-1');
    expect(profiles.length).toBe(1);
  });

  test('ignores non-oracle_added updates', () => {
    const db = new Database(':memory:');
    migration005.up(db);
    const profileStore = new OracleProfileStore(db);

    const capMgr = new CapabilityManager({
      instanceId: 'local-1',
      peerUrls: [],
      oracleProfileStore: profileStore,
    });

    capMgr.handleUpdate('peer-1', {
      instance_id: 'peer-1',
      capability_version: 1,
      update_type: 'oracle_metrics',
      delta: { oracle_name: 'type-oracle', action: 'updated' },
      timestamp: Date.now(),
    });

    const profiles = profileStore.getProfilesByInstance('peer-1');
    expect(profiles.length).toBe(0);
  });
});
