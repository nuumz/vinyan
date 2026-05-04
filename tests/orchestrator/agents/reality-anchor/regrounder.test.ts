/**
 * Tests for `RealityAnchorReGrounder` — Phase C4 state machine.
 *
 * Behavior-only: every assertion drives the regrounder with synthetic
 * inputs and verifies state transitions + audit rows + bus emissions
 * against the documented contract.
 *
 * Coverage:
 *   - default state is 'active' for unseen personas
 *   - startRegrounding fires all 5 audit stages in order + lands in shadow-mode
 *   - psychosis:trigger from bus invokes startRegrounding
 *   - state transitions enforce monotonic timestamps (no PK collisions)
 *   - shadow streak: clean traces accumulate; non-clean resets
 *   - reentry fires when streak hits cleanStreakRequired
 *   - delusion-flagged trace counts as non-clean (resets streak)
 *   - state hydration from audit store survives restart
 *   - per-persona isolation
 *   - canDispatch reflects current state correctly
 */
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { createBus, type VinyanBus } from '../../../../src/core/bus.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../../../src/db/migrations/index.ts';
import { RealityAnchorAuditStore } from '../../../../src/db/reality-anchor-audit-store.ts';
import { RealityAnchorReGrounder } from '../../../../src/orchestrator/agents/reality-anchor/regrounder.ts';
import type { ExecutionTrace } from '../../../../src/orchestrator/types.ts';

let db: Database;
let auditStore: RealityAnchorAuditStore;
let bus: VinyanBus;

beforeEach(() => {
  db = new Database(':memory:');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  auditStore = new RealityAnchorAuditStore(db);
  bus = createBus();
});

function trace(overrides: Omit<Partial<ExecutionTrace>, 'agentId'> & { agentId?: string }): ExecutionTrace {
  return {
    id: `t-${Math.random().toString(36).slice(2, 8)}`,
    taskId: 'task',
    timestamp: Date.now(),
    routingLevel: 1,
    approach: 'a',
    oracleVerdicts: { ast: true },
    modelUsed: 'mock',
    tokensConsumed: 0,
    durationMs: 0,
    outcome: 'success',
    affectedFiles: [],
    ...overrides,
  } as ExecutionTrace;
}

describe('RealityAnchorReGrounder — defaults', () => {
  test('unseen persona is active', () => {
    const r = new RealityAnchorReGrounder({ bus, auditStore });
    expect(r.getState('researcher')).toBe('active');
    expect(r.canDispatch('researcher')).toBe(true);
  });
});

describe('RealityAnchorReGrounder — startRegrounding', () => {
  test('fires 5 audit stages in order and lands in shadow-mode', () => {
    let now = 1000;
    const r = new RealityAnchorReGrounder({ bus, auditStore, clock: () => now++ });
    r.startRegrounding('researcher', 'manual op-trigger');
    expect(r.getState('researcher')).toBe('shadow-mode');
    expect(r.canDispatch('researcher')).toBe(true);

    const rows = auditStore.listForPersona('researcher');
    // listForPersona is newest-first; reverse for chronological.
    const stages = rows.map((row) => row.stage).reverse();
    expect(stages).toEqual(['quarantine', 'rebuild', 'prune', 'replay', 'replay']);
    // (the final 'replay' is the rebuilding→shadow-mode transition; the prior
    // 'replay' is the in-rebuilding sub-action — both labeled 'replay' per
    // the documented stage mapping)
  });

  test('audit timestamps are strictly monotonic per persona (no PK collision)', () => {
    // Clock returns the SAME value for all 5 calls — exercise the
    // monotonic-ts guard in nextTs.
    const r = new RealityAnchorReGrounder({ bus, auditStore, clock: () => 1000 });
    r.startRegrounding('researcher', 'r');
    const rows = auditStore.listForPersona('researcher');
    const ts = rows.map((row) => row.recordedAt).sort((a, b) => a - b);
    // All distinct
    expect(new Set(ts).size).toBe(ts.length);
    // 5 rows
    expect(ts).toHaveLength(5);
  });

  test('canDispatch is false during quarantined / rebuilding', () => {
    // Test seam: stop the regrounding mid-walk by hand-rolling the audit.
    auditStore.recordAudit({
      personaId: 'p',
      prevState: 'active',
      newState: 'quarantined',
      stage: 'quarantine',
      reason: 'test',
      recordedAt: 1000,
    });
    const r = new RealityAnchorReGrounder({ bus, auditStore });
    expect(r.canDispatch('p')).toBe(false);
    expect(r.getState('p')).toBe('quarantined');
  });
});

describe('RealityAnchorReGrounder — psychosis:trigger reaction', () => {
  test('bus event invokes startRegrounding for the named persona', () => {
    let now = 1000;
    const r = new RealityAnchorReGrounder({ bus, auditStore, clock: () => now++ });
    r.attach();
    bus.emit('psychosis:trigger', {
      personaId: 'researcher',
      signal: 'delusion',
      value: 0.5,
      ceiling: 0.15,
      windowSize: 10,
    });
    expect(r.getState('researcher')).toBe('shadow-mode');
    const rows = auditStore.listForPersona('researcher');
    expect(rows).toHaveLength(5);
    expect(rows[rows.length - 1]?.stage).toBe('quarantine');
    expect(rows[rows.length - 1]?.reason).toContain('delusion');
  });
});

describe('RealityAnchorReGrounder — shadow streak + reentry', () => {
  test('clean traces accumulate streak; reentry fires at threshold', () => {
    let now = 1000;
    const r = new RealityAnchorReGrounder({
      bus,
      auditStore,
      clock: () => now++,
      cleanStreakRequired: 3,
    });
    r.startRegrounding('researcher', 'init');
    expect(r.getState('researcher')).toBe('shadow-mode');

    // First 2 clean traces: streak 1, 2 (no reentry yet)
    r.onTraceRecord(trace({ agentId: 'researcher' }));
    expect(r.shadowStreakFor('researcher')).toBe(1);
    expect(r.getState('researcher')).toBe('shadow-mode');
    r.onTraceRecord(trace({ agentId: 'researcher' }));
    expect(r.shadowStreakFor('researcher')).toBe(2);
    expect(r.getState('researcher')).toBe('shadow-mode');
    // Third clean trace → reentry
    r.onTraceRecord(trace({ agentId: 'researcher' }));
    expect(r.getState('researcher')).toBe('active');
    expect(r.canDispatch('researcher')).toBe(true);

    // Audit row for reentry exists
    const rows = auditStore.listForPersona('researcher');
    expect(rows[0]?.stage).toBe('reentry');
    expect(rows[0]?.newState).toBe('active');
  });

  test('non-clean trace (failure outcome) resets streak', () => {
    let now = 1000;
    const r = new RealityAnchorReGrounder({
      bus,
      auditStore,
      clock: () => now++,
      cleanStreakRequired: 3,
    });
    r.startRegrounding('p', 'init');
    r.onTraceRecord(trace({ agentId: 'p' }));
    r.onTraceRecord(trace({ agentId: 'p' }));
    expect(r.shadowStreakFor('p')).toBe(2);
    // Failure trace
    r.onTraceRecord(trace({ agentId: 'p', outcome: 'failure' }));
    expect(r.shadowStreakFor('p')).toBe(0);
    // Persona stays in shadow-mode (no bounce-back to quarantine on simple failure)
    expect(r.getState('p')).toBe('shadow-mode');
  });

  test('non-clean trace (delusion present) resets streak', () => {
    let now = 1000;
    const r = new RealityAnchorReGrounder({
      bus,
      auditStore,
      clock: () => now++,
      cleanStreakRequired: 3,
    });
    r.startRegrounding('p', 'init');
    r.onTraceRecord(trace({ agentId: 'p' }));
    r.onTraceRecord(trace({ agentId: 'p' }));
    expect(r.shadowStreakFor('p')).toBe(2);
    // Delusion-flagged trace
    r.onTraceRecord(
      trace({
        agentId: 'p',
        delusionResult: { kind: 'delusion', falsifiedCount: 1 },
      }),
    );
    expect(r.shadowStreakFor('p')).toBe(0);
  });

  test('traces during active state are ignored (only count in shadow-mode)', () => {
    const r = new RealityAnchorReGrounder({
      bus,
      auditStore,
      cleanStreakRequired: 3,
    });
    // Persona starts active; clean traces should not change streak
    r.onTraceRecord(trace({ agentId: 'researcher' }));
    r.onTraceRecord(trace({ agentId: 'researcher' }));
    r.onTraceRecord(trace({ agentId: 'researcher' }));
    expect(r.getState('researcher')).toBe('active');
    expect(r.shadowStreakFor('researcher')).toBe(0);
  });

  test('traces without agentId are silently skipped', () => {
    const r = new RealityAnchorReGrounder({ bus, auditStore });
    r.startRegrounding('p', 'init');
    r.onTraceRecord(trace({})); // no agentId
    expect(r.shadowStreakFor('p')).toBe(0);
    expect(r.getState('p')).toBe('shadow-mode');
  });
});

describe('RealityAnchorReGrounder — bounce on fresh trigger during recovery', () => {
  test('psychosis:trigger during shadow-mode resets persona back to quarantined', () => {
    let now = 1000;
    const r = new RealityAnchorReGrounder({ bus, auditStore, clock: () => now++ });
    r.attach();
    // First trigger → walks to shadow-mode
    bus.emit('psychosis:trigger', {
      personaId: 'p',
      signal: 'delusion',
      value: 0.5,
      ceiling: 0.15,
      windowSize: 10,
    });
    expect(r.getState('p')).toBe('shadow-mode');
    // Second trigger DURING shadow-mode → bounce back to quarantined,
    // walks to shadow-mode again
    bus.emit('psychosis:trigger', {
      personaId: 'p',
      signal: 'contradiction',
      value: 0.4,
      ceiling: 0.2,
      windowSize: 12,
    });
    expect(r.getState('p')).toBe('shadow-mode');
    // 10 audit rows total (5 + 5)
    expect(auditStore.listForPersona('p')).toHaveLength(10);
  });
});

describe('RealityAnchorReGrounder — state hydration', () => {
  test('persona state survives restart via audit-table hydration', () => {
    let now = 1000;
    const r1 = new RealityAnchorReGrounder({ bus, auditStore, clock: () => now++ });
    r1.startRegrounding('researcher', 'first run');
    expect(r1.getState('researcher')).toBe('shadow-mode');

    // Simulate restart: new bus, new regrounder, same audit store
    const newBus = createBus();
    const r2 = new RealityAnchorReGrounder({ bus: newBus, auditStore });
    expect(r2.getState('researcher')).toBe('shadow-mode');
  });
});

describe('RealityAnchorReGrounder — per-persona isolation', () => {
  test('A regrounding does not affect B', () => {
    let now = 1000;
    const r = new RealityAnchorReGrounder({ bus, auditStore, clock: () => now++ });
    r.startRegrounding('A', 'A trigger');
    expect(r.getState('A')).toBe('shadow-mode');
    expect(r.getState('B')).toBe('active');
    r.startRegrounding('B', 'B trigger');
    expect(r.getState('A')).toBe('shadow-mode');
    expect(r.getState('B')).toBe('shadow-mode');
  });
});

describe('RealityAnchorReGrounder — attach', () => {
  test('attach returns unsubscribe; after detach, bus events are ignored', () => {
    const r = new RealityAnchorReGrounder({ bus, auditStore });
    const unsub = r.attach();
    bus.emit('psychosis:trigger', {
      personaId: 'p',
      signal: 'delusion',
      value: 0.5,
      ceiling: 0.15,
      windowSize: 10,
    });
    expect(r.getState('p')).toBe('shadow-mode');
    unsub();
    bus.emit('psychosis:trigger', {
      personaId: 'q',
      signal: 'delusion',
      value: 0.5,
      ceiling: 0.15,
      windowSize: 10,
    });
    expect(r.getState('q')).toBe('active'); // detached, no recovery started
  });
});
