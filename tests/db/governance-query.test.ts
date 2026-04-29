import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  buildDecisionReplay,
  formatReplayForCLI,
  GOVERNANCE_QUERY_DEFAULT_LIMIT,
  GOVERNANCE_QUERY_MAX_LIMIT,
  normalizeGovernanceQuery,
  summarizeGovernanceTrace,
} from '../../src/db/governance-query.ts';
import { TRACE_SCHEMA_SQL } from '../../src/db/trace-schema.ts';
import { TraceStore } from '../../src/db/trace-store.ts';
import type { ExecutionTrace, GovernanceProvenance } from '../../src/orchestrator/types.ts';

function createDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(TRACE_SCHEMA_SQL);
  return db;
}

function makeProvenance(overrides: Partial<GovernanceProvenance> = {}): GovernanceProvenance {
  return {
    decisionId: 'orchestrator:task-1:short-circuit-l0',
    policyVersion: 'orchestrator-governance:v1',
    attributedTo: 'orchestrator',
    wasGeneratedBy: 'risk-router',
    wasDerivedFrom: [
      { kind: 'task-input', source: 'task-1', observedAt: 1_700_000_000_000, summary: 'taskType=code; source=cli' },
    ],
    decidedAt: 1_700_000_000_000,
    evidenceObservedAt: 1_700_000_000_000,
    reason: 'L0 short-circuit',
    escalationPath: [0, 1],
    ...overrides,
  };
}

function makeTrace(overrides: Partial<ExecutionTrace> = {}): ExecutionTrace {
  return {
    id: `trace-${Math.random().toString(36).slice(2, 8)}`,
    taskId: 'task-1',
    timestamp: 1_700_000_000_000,
    routingLevel: 0,
    approach: 'reflex',
    oracleVerdicts: { ast: true },
    modelUsed: 'none',
    tokensConsumed: 0,
    durationMs: 50,
    outcome: 'success',
    affectedFiles: [],
    ...overrides,
  };
}

describe('governance-query — normalize', () => {
  test('clamps limit and defaults offset', () => {
    expect(normalizeGovernanceQuery({ limit: 9999 }).limit).toBe(GOVERNANCE_QUERY_MAX_LIMIT);
    expect(normalizeGovernanceQuery({ limit: -5 }).limit).toBe(GOVERNANCE_QUERY_DEFAULT_LIMIT);
    expect(normalizeGovernanceQuery({}).limit).toBe(GOVERNANCE_QUERY_DEFAULT_LIMIT);
    expect(normalizeGovernanceQuery({ offset: -1 }).offset).toBe(0);
    expect(normalizeGovernanceQuery({ offset: 12 }).offset).toBe(12);
  });
});

describe('governance-query — summarize/replay formatters', () => {
  test('summarizeGovernanceTrace marks legacy traces unavailable', () => {
    const trace = makeTrace({ governanceProvenance: undefined });
    const summary = summarizeGovernanceTrace(trace);
    expect(summary.availability).toBe('unavailable');
    expect(summary.decisionId).toBeUndefined();
    expect(summary.evidenceCount).toBe(0);
  });

  test('summarizeGovernanceTrace surfaces provenance facets', () => {
    const provenance = makeProvenance();
    const trace = makeTrace({ governanceProvenance: provenance });
    const summary = summarizeGovernanceTrace(trace);
    expect(summary.availability).toBe('available');
    expect(summary.decisionId).toBe(provenance.decisionId);
    expect(summary.policyVersion).toBe(provenance.policyVersion);
    expect(summary.governanceActor).toBe(provenance.attributedTo);
    expect(summary.evidenceCount).toBe(1);
    expect(summary.escalationPath).toEqual([0, 1]);
  });

  test('buildDecisionReplay surfaces persisted confidence verbatim', () => {
    const trace = makeTrace({
      governanceProvenance: makeProvenance(),
      pipelineConfidence: { composite: 0.847, formula: 'persisted' },
    });
    const replay = buildDecisionReplay('orchestrator:task-1:short-circuit-l0', trace);
    expect(replay.availability).toBe('available');
    expect(replay.pipelineConfidence?.composite).toBe(0.847);
    expect(replay.evidence).toHaveLength(1);
  });

  test('buildDecisionReplay marks unavailable for legacy trace', () => {
    const trace = makeTrace({ governanceProvenance: undefined });
    const replay = buildDecisionReplay('legacy:1', trace);
    expect(replay.availability).toBe('unavailable');
    expect(replay.evidence).toEqual([]);
    expect(replay.policyVersion).toBeUndefined();
  });

  test('formatReplayForCLI shows legacy notice when unavailable', () => {
    const trace = makeTrace({ governanceProvenance: undefined });
    const out = formatReplayForCLI(buildDecisionReplay('legacy:1', trace));
    expect(out).toContain('Availability:    unavailable');
    expect(out).toContain('legacy trace');
  });

  test('formatReplayForCLI renders provenance + evidence + escalation', () => {
    const trace = makeTrace({
      governanceProvenance: makeProvenance(),
      pipelineConfidence: { composite: 0.5, formula: 'p' },
    });
    const out = formatReplayForCLI(buildDecisionReplay('orchestrator:task-1:short-circuit-l0', trace));
    expect(out).toContain('Decision:');
    expect(out).toContain('Policy Version:  orchestrator-governance:v1');
    expect(out).toContain('Attributed To:   orchestrator');
    expect(out).toContain('Escalation:      L0 → L1');
    expect(out).toContain('Confidence:      0.500');
    expect(out).toContain('[task-input] task-1');
  });
});

describe('TraceStore — governance query/replay', () => {
  let db: Database;
  let store: TraceStore;

  beforeEach(() => {
    db = createDb();
    store = new TraceStore(db);
  });
  afterEach(() => {
    db.close();
  });

  test('queryGovernance filters by decisionId', () => {
    store.insert(makeTrace({ id: 't1', governanceProvenance: makeProvenance({ decisionId: 'd-A' }) }));
    store.insert(makeTrace({ id: 't2', governanceProvenance: makeProvenance({ decisionId: 'd-B' }) }));
    const result = store.queryGovernance({ decisionId: 'd-A' });
    expect(result.total).toBe(1);
    expect(result.rows[0]!.traceId).toBe('t1');
  });

  test('queryGovernance filters by policyVersion + actor', () => {
    store.insert(
      makeTrace({
        id: 't1',
        governanceProvenance: makeProvenance({ policyVersion: 'orchestrator-governance:v1', attributedTo: 'router' }),
      }),
    );
    store.insert(
      makeTrace({
        id: 't2',
        governanceProvenance: makeProvenance({ policyVersion: 'goal-time-grounding:v1', attributedTo: 'goal-grounding' }),
      }),
    );
    const v1 = store.queryGovernance({ policyVersion: 'orchestrator-governance:v1' });
    expect(v1.total).toBe(1);
    expect(v1.rows[0]!.traceId).toBe('t1');

    const byActor = store.queryGovernance({ governanceActor: 'goal-grounding' });
    expect(byActor.total).toBe(1);
    expect(byActor.rows[0]!.traceId).toBe('t2');
  });

  test('queryGovernance time-range filter inclusive', () => {
    store.insert(makeTrace({ id: 't1', governanceProvenance: makeProvenance({ decidedAt: 1000 }) }));
    store.insert(makeTrace({ id: 't2', governanceProvenance: makeProvenance({ decidedAt: 2000 }) }));
    store.insert(makeTrace({ id: 't3', governanceProvenance: makeProvenance({ decidedAt: 3000 }) }));
    const r = store.queryGovernance({ decisionFrom: 1500, decisionTo: 2500 });
    expect(r.total).toBe(1);
    expect(r.rows[0]!.traceId).toBe('t2');
  });

  test('queryGovernance pagination via limit/offset', () => {
    for (let i = 0; i < 5; i++) {
      store.insert(makeTrace({ id: `t${i}`, governanceProvenance: makeProvenance({ decidedAt: 1000 + i }) }));
    }
    const page1 = store.queryGovernance({ limit: 2, offset: 0 });
    const page2 = store.queryGovernance({ limit: 2, offset: 2 });
    expect(page1.rows).toHaveLength(2);
    expect(page2.rows).toHaveLength(2);
    expect(page1.total).toBe(5);
    // DESC order on decidedAt: page1 newest first.
    expect(page1.rows[0]!.traceId).toBe('t4');
    expect(page2.rows[0]!.traceId).toBe('t2');
  });

  test('queryGovernance with no filters surfaces legacy traces as unavailable', () => {
    store.insert(makeTrace({ id: 't1', governanceProvenance: undefined }));
    store.insert(makeTrace({ id: 't2', governanceProvenance: makeProvenance({ decisionId: 'd-A' }) }));
    const all = store.queryGovernance({});
    expect(all.total).toBe(2);
    const availabilities = all.rows.map((r) => r.availability).sort();
    expect(availabilities).toEqual(['available', 'unavailable']);
  });

  test('findTraceByDecisionId returns trace; missing returns undefined', () => {
    store.insert(makeTrace({ id: 't1', governanceProvenance: makeProvenance({ decisionId: 'd-X' }) }));
    expect(store.findTraceByDecisionId('d-X')?.id).toBe('t1');
    expect(store.findTraceByDecisionId('missing')).toBeUndefined();
  });
});
