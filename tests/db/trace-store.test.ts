import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { QualityScore } from '../../src/core/types.ts';
import { TRACE_SCHEMA_SQL } from '../../src/db/trace-schema.ts';
import { TraceStore } from '../../src/db/trace-store.ts';
import type { ExecutionTrace } from '../../src/orchestrator/types.ts';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(TRACE_SCHEMA_SQL);
  return db;
}

function makeTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    id: 'trace-001',
    taskId: 'task-001',
    timestamp: Date.now(),
    routingLevel: 1,
    approach: 'direct-edit',
    oracleVerdicts: { ast: true, type: true, dep: false },
    modelUsed: 'claude-haiku',
    tokensConsumed: 500,
    durationMs: 1200,
    outcome: 'success',
    affectedFiles: ['src/foo.ts', 'src/bar.ts'],
    ...overrides,
  };
}

const PHASE1_QUALITY: QualityScore = {
  architecturalCompliance: 0.85,
  efficiency: 0.72,
  simplificationGain: 0.6,
  testPresenceHeuristic: 0.45,
  composite: 0.66,
  dimensionsAvailable: 4,
  phase: 'extended',
};

describe('TraceStore', () => {
  let db: Database;
  let store: TraceStore;

  beforeEach(() => {
    db = createTestDb();
    store = new TraceStore(db);
  });

  afterEach(() => {
    db.close();
  });

  test('insert and query roundtrip', () => {
    const trace = makeTrace();
    store.insert(trace);

    const results = store.findRecent(10);
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe('trace-001');
    expect(results[0]!.taskId).toBe('task-001');
    expect(results[0]!.routingLevel).toBe(1);
    expect(results[0]!.approach).toBe('direct-edit');
    expect(results[0]!.modelUsed).toBe('claude-haiku');
    expect(results[0]!.tokensConsumed).toBe(500);
    expect(results[0]!.outcome).toBe('success');
  });

  test('JSON fields deserialized correctly', () => {
    const trace = makeTrace({
      oracleVerdicts: { ast: true, type: false },
      affectedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    });
    store.insert(trace);

    const result = store.findRecent(1)[0]!;
    expect(result.oracleVerdicts).toEqual({ ast: true, type: false });
    expect(result.affectedFiles).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  test('capability-first metadata roundtrips for sleep-cycle promotion', () => {
    const trace = makeTrace({
      agentId: 'ts-coder',
      taskTypeSignature: 'review::ts',
      capabilityRequirements: [
        {
          id: 'code.review.ts',
          weight: 0.9,
          source: 'llm-extract',
          fileExtensions: ['.ts'],
          actionVerbs: ['review'],
        },
      ],
      capabilityAnalysis: {
        taskId: 'task-001',
        required: [
          {
            id: 'code.review.ts',
            weight: 0.9,
            source: 'llm-extract',
          },
        ],
        candidates: [
          {
            agentId: 'ts-coder',
            profileId: 'ts-coder',
            profileSource: 'registry',
            trustTier: 'deterministic',
            fitScore: 0.8,
            matched: [{ id: 'code.refactor.ts', weight: 0.4, confidence: 0.9 }],
            gap: [{ id: 'code.review.ts', weight: 0.9 }],
          },
        ],
        gapNormalized: 0.2,
        recommendedAction: 'proceed',
      },
      agentSelectionReason: 'capability-router override (score 0.80)',
      selectedCapabilityProfileId: 'ts-coder',
      selectedCapabilityProfileSource: 'registry',
      selectedCapabilityProfileTrustTier: 'deterministic',
      capabilityFitScore: 0.8,
      unmetCapabilityIds: ['code.review.ts'],
      syntheticAgentId: 'synthetic-abc12345',
      knowledgeUsed: [
        {
          source: 'workspace-docs',
          capability: 'code.review.ts',
          query: 'code review ts',
          content: 'Review checklist',
          reference: 'docs/review.md',
          confidence: 0.4,
          retrievedAt: 1234,
        },
      ],
    });
    store.insert(trace);

    const result = store.findRecent(1)[0]!;
    expect(result.capabilityRequirements).toEqual(trace.capabilityRequirements);
    expect(result.capabilityAnalysis).toEqual(trace.capabilityAnalysis);
    expect(result.agentSelectionReason).toBe('capability-router override (score 0.80)');
    expect(result.selectedCapabilityProfileId).toBe('ts-coder');
    expect(result.selectedCapabilityProfileSource).toBe('registry');
    expect(result.selectedCapabilityProfileTrustTier).toBe('deterministic');
    expect(result.capabilityFitScore).toBe(0.8);
    expect(result.unmetCapabilityIds).toEqual(['code.review.ts']);
    expect(result.syntheticAgentId).toBe('synthetic-abc12345');
    expect(result.knowledgeUsed).toEqual(trace.knowledgeUsed);
  });

  test('A8 governance provenance roundtrips and denormalizes audit columns', () => {
    const trace = makeTrace({
      governanceProvenance: {
        decisionId: 'route-task-001-L2',
        policyVersion: 'risk-router:v1',
        attributedTo: 'riskRouter',
        wasGeneratedBy: 'assessInitialLevel',
        wasDerivedFrom: [
          {
            kind: 'file',
            source: 'src/auth.ts',
            contentHash: 'sha256:abc123',
            observedAt: 1_777_400_000_000,
            summary: 'blastRadius=3',
          },
          {
            kind: 'routing-factor',
            source: 'risk-score',
            summary: 'riskScore=0.72',
          },
        ],
        decidedAt: 1_777_400_001_000,
        evidenceObservedAt: 1_777_400_000_000,
        reason: 'riskScore=0.72 -> L2',
        escalationPath: [0, 1, 2],
      },
    });

    store.insert(trace);

    const result = store.findRecent(1)[0]!;
    expect(result.governanceProvenance).toEqual(trace.governanceProvenance);

    const row = db
      .query(
        'SELECT routing_decision_id, policy_version, governance_actor, decision_timestamp, evidence_observed_at FROM execution_traces WHERE id = ?',
      )
      .get(trace.id) as Record<string, unknown>;
    expect(row.routing_decision_id).toBe('route-task-001-L2');
    expect(row.policy_version).toBe('risk-router:v1');
    expect(row.governance_actor).toBe('riskRouter');
    expect(row.decision_timestamp).toBe(1_777_400_001_000);
    expect(row.evidence_observed_at).toBe(1_777_400_000_000);
  });

  test('legacy traces without governance provenance remain readable', () => {
    store.insert(makeTrace());

    const result = store.findRecent(1)[0]!;
    expect(result.governanceProvenance).toBeUndefined();
  });

  test('A10 goal grounding checks roundtrip as trace audit metadata', () => {
    const trace = makeTrace({
      goalGrounding: [
        {
          taskId: 'task-001',
          phase: 'verify',
          routingLevel: 2,
          policyVersion: 'goal-time-grounding:v1',
          checkedAt: 1_777_400_002_000,
          action: 'downgrade-confidence',
          reason: 'Temporal grounding found 1 stale or low-confidence fact(s)',
          rootGoalHash: 'sha256:root',
          currentGoalHash: 'sha256:root',
          goalDrift: false,
          freshnessDowngraded: true,
          factCount: 2,
          staleFactCount: 1,
          minFactConfidence: 0.2,
          evidence: [
            {
              kind: 'other',
              source: 'fact-low',
              contentHash: 'sha256:abc',
              observedAt: 1_777_400_000_000,
              summary: 'fact=src/auth.ts; confidence=0.200; validUntil=1777400001000',
            },
          ],
        },
      ],
    });

    store.insert(trace);

    const result = store.findRecent(1)[0]!;
    expect(result.goalGrounding).toEqual(trace.goalGrounding);
  });

  test('QualityScore denormalized into columns and reconstructed', () => {
    const trace = makeTrace({ qualityScore: PHASE1_QUALITY });
    store.insert(trace);

    const result = store.findRecent(1)[0]!;
    expect(result.qualityScore).toBeDefined();
    expect(result.qualityScore!.architecturalCompliance).toBe(0.85);
    expect(result.qualityScore!.efficiency).toBe(0.72);
    expect(result.qualityScore!.simplificationGain).toBe(0.6);
    expect(result.qualityScore!.testPresenceHeuristic).toBe(0.45);
    expect(result.qualityScore!.composite).toBe(0.66);
    expect(result.qualityScore!.dimensionsAvailable).toBe(4);
    expect(result.qualityScore!.phase).toBe('extended');
  });

  test('trace without QualityScore returns undefined', () => {
    store.insert(makeTrace());

    const result = store.findRecent(1)[0]!;
    expect(result.qualityScore).toBeUndefined();
  });

  test('basic QualityScore (2 dims) roundtrip', () => {
    const basic: QualityScore = {
      architecturalCompliance: 0.9,
      efficiency: 0.8,
      composite: 0.86,
      dimensionsAvailable: 2,
      phase: 'basic',
    };
    store.insert(makeTrace({ qualityScore: basic }));

    const result = store.findRecent(1)[0]!;
    expect(result.qualityScore!.phase).toBe('basic');
    expect(result.qualityScore!.dimensionsAvailable).toBe(2);
    expect(result.qualityScore!.simplificationGain).toBeUndefined();
  });

  test('findByTaskType filters correctly', () => {
    store.insert(makeTrace({ id: 't1', taskTypeSignature: 'refactor:rename' }));
    store.insert(makeTrace({ id: 't2', taskTypeSignature: 'bugfix:null-check' }));
    store.insert(makeTrace({ id: 't3', taskTypeSignature: 'refactor:rename' }));

    const refactors = store.findByTaskType('refactor:rename');
    expect(refactors).toHaveLength(2);
    expect(refactors.every((t) => t.taskTypeSignature === 'refactor:rename')).toBe(true);
  });

  test('findByOutcome filters correctly', () => {
    store.insert(makeTrace({ id: 't1', outcome: 'success' }));
    store.insert(makeTrace({ id: 't2', outcome: 'failure', failureReason: 'type error' }));
    store.insert(makeTrace({ id: 't3', outcome: 'timeout' }));

    const failures = store.findByOutcome('failure');
    expect(failures).toHaveLength(1);
    expect(failures[0]!.failureReason).toBe('type error');
  });

  test('findByTimeRange filters correctly', () => {
    const now = Date.now();
    store.insert(makeTrace({ id: 't1', timestamp: now - 5000 }));
    store.insert(makeTrace({ id: 't2', timestamp: now - 1000 }));
    store.insert(makeTrace({ id: 't3', timestamp: now + 5000 }));

    const results = store.findByTimeRange(now - 6000, now);
    expect(results).toHaveLength(2);
    expect(results[0]!.id).toBe('t1'); // ASC order
    expect(results[1]!.id).toBe('t2');
  });

  test('count returns total traces', () => {
    expect(store.count()).toBe(0);
    store.insert(makeTrace({ id: 't1' }));
    store.insert(makeTrace({ id: 't2' }));
    expect(store.count()).toBe(2);
  });

  test('countDistinctTaskTypes counts unique signatures', () => {
    store.insert(makeTrace({ id: 't1', taskTypeSignature: 'a' }));
    store.insert(makeTrace({ id: 't2', taskTypeSignature: 'a' }));
    store.insert(makeTrace({ id: 't3', taskTypeSignature: 'b' }));
    store.insert(makeTrace({ id: 't4' })); // no signature — not counted

    expect(store.countDistinctTaskTypes()).toBe(2);
  });

  test('predictionError JSON roundtrip', () => {
    const trace = makeTrace({
      predictionError: {
        taskId: 'task-001',
        predicted: {
          taskId: 'task-001',
          timestamp: Date.now(),
          expectedTestResults: 'pass',
          expectedBlastRadius: 3,
          expectedDuration: 5000,
          expectedQualityScore: 0.7,
          uncertainAreas: [],
          confidence: 0.6,
          metaConfidence: 0.2,
          basis: 'static-heuristic',
          calibrationDataPoints: 0,
        },
        actual: { testResults: 'fail', blastRadius: 5, duration: 8000, qualityScore: 0.4 },
        error: {
          testResultMatch: false,
          blastRadiusDelta: 2,
          durationDelta: 3000,
          qualityScoreDelta: -0.3,
          composite: 0.45,
        },
      },
    });
    store.insert(trace);

    const result = store.findRecent(1)[0]!;
    expect(result.predictionError).toBeDefined();
    expect(result.predictionError!.error.composite).toBe(0.45);
    expect(result.predictionError!.actual.testResults).toBe('fail');
  });

  test('optional fields handled gracefully', () => {
    store.insert(
      makeTrace({
        sessionId: 'sess-1',
        workerId: 'w-1',
        approachDescription: 'detailed explanation',
        riskScore: 0.35,
        validationDepth: 'structural',
      }),
    );

    const result = store.findRecent(1)[0]!;
    expect(result.sessionId).toBe('sess-1');
    expect(result.workerId).toBe('w-1');
    expect(result.approachDescription).toBe('detailed explanation');
    expect(result.riskScore).toBe(0.35);
    expect(result.validationDepth).toBe('structural');
  });
});
