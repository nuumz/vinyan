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

describe('RealityAnchorReGrounder — sub-action work bodies (Phase C4-followup)', () => {
  test('rebuild work drops citations older than rebuildHorizonMs for the persona', async () => {
    const { PersonaFactCitationsStore } = await import('../../../../src/db/persona-fact-citations-store.ts');
    const citationsStore = new PersonaFactCitationsStore(db);
    // Seed 3 old + 2 new citations for persona 'p', plus 1 each for 'q'
    let ts = 1_000_000;
    for (const factId of ['old-a', 'old-b', 'old-c']) {
      citationsStore.recordCitation({
        personaId: 'p',
        factId,
        citedAtHash: 'h',
        taskId: 't',
        phase: 'verify',
        claimExcerpt: 'x',
        citedAtTs: ts,
      });
      ts += 1;
    }
    // 8 days later (clock will be at 9 days from start)
    const newTs = ts + 8 * 24 * 60 * 60 * 1000;
    for (const factId of ['new-a', 'new-b']) {
      citationsStore.recordCitation({
        personaId: 'p',
        factId,
        citedAtHash: 'h',
        taskId: 't',
        phase: 'verify',
        claimExcerpt: 'x',
        citedAtTs: newTs,
      });
    }
    citationsStore.recordCitation({
      personaId: 'q',
      factId: 'q-old',
      citedAtHash: 'h',
      taskId: 't',
      phase: 'verify',
      claimExcerpt: 'x',
      citedAtTs: 1_000_000,
    });

    // Clock at newTs + 1 day → cutoff = clock - 7 days = newTs - 6 days, which
    // is AFTER the 'old-*' citations (1_000_000) and BEFORE the 'new-*' (newTs).
    // So the old citations get dropped, the new ones survive.
    const clockNow = newTs + 24 * 60 * 60 * 1000;
    const r = new RealityAnchorReGrounder({
      bus,
      auditStore,
      citationsStore,
      clock: () => clockNow,
    });
    r.startRegrounding('p', 'test');

    // Persona 'p' lost the old citations
    const remaining = citationsStore.listForPersona('p').map((c) => c.factId);
    expect(remaining.sort()).toEqual(['new-a', 'new-b']);
    // Persona 'q' citations untouched (rebuild scoped to 'p')
    expect(citationsStore.listForPersona('q')).toHaveLength(1);

    // Audit reason captures the drop count
    const auditRows = auditStore.listForPersona('p');
    const rebuildRow = auditRows.find((row) => row.stage === 'rebuild');
    expect(rebuildRow?.reason).toContain('rebuild=dropped 3');
  });

  test('rebuild reports skipped when citationsStore is unwired', () => {
    const r = new RealityAnchorReGrounder({ bus, auditStore });
    r.startRegrounding('p', 'test');
    const rebuildRow = auditStore.listForPersona('p').find((row) => row.stage === 'rebuild');
    expect(rebuildRow?.reason).toContain('rebuild=skipped');
  });

  test('prune skipped reason when citationsStore unwired', () => {
    const r = new RealityAnchorReGrounder({ bus, auditStore });
    r.startRegrounding('p', 'test');
    const pruneRow = auditStore.listForPersona('p').find((row) => row.stage === 'prune');
    expect(pruneRow?.reason).toContain('prune=skipped');
  });

  test('prune drops superseded citations for the persona (Phase C4-followup real work)', async () => {
    const { PersonaFactCitationsStore } = await import('../../../../src/db/persona-fact-citations-store.ts');
    const citationsStore = new PersonaFactCitationsStore(db);
    // Persona 'p' cited fact 'a' three times at different hashes
    // (e.g., file mutated between citations and persona kept observing).
    citationsStore.recordCitation({
      personaId: 'p',
      factId: 'a',
      citedAtHash: 'h1',
      taskId: 't1',
      phase: 'verify',
      claimExcerpt: 'first',
      citedAtTs: 100_000_000_000_000,
    });
    citationsStore.recordCitation({
      personaId: 'p',
      factId: 'a',
      citedAtHash: 'h2',
      taskId: 't2',
      phase: 'verify',
      claimExcerpt: 'second',
      citedAtTs: 100_000_000_000_001,
    });
    citationsStore.recordCitation({
      personaId: 'p',
      factId: 'a',
      citedAtHash: 'h3',
      taskId: 't3',
      phase: 'verify',
      claimExcerpt: 'latest',
      citedAtTs: 100_000_000_000_002,
    });
    // Singleton citation for 'b' — should not be dropped.
    citationsStore.recordCitation({
      personaId: 'p',
      factId: 'b',
      citedAtHash: 'hb',
      taskId: 't4',
      phase: 'verify',
      claimExcerpt: 'b-only',
      citedAtTs: 100_000_000_000_003,
    });
    // Different persona — should be untouched.
    citationsStore.recordCitation({
      personaId: 'q',
      factId: 'a',
      citedAtHash: 'q-h1',
      taskId: 'tq',
      phase: 'verify',
      claimExcerpt: 'q-claim',
      citedAtTs: 100_000_000_000_004,
    });

    // Use a clock far in the past so rebuild horizon (7d) doesn't drop
    // anything — isolate prune's effect.
    const r = new RealityAnchorReGrounder({
      bus,
      auditStore,
      citationsStore,
      clock: () => 100_000_000_000_005,
    });
    r.startRegrounding('p', 'test');

    // Persona 'p': only the latest citation of 'a' (h3) + the singleton 'b' survive
    const pCitations = citationsStore.listForPersona('p');
    expect(pCitations).toHaveLength(2);
    expect(pCitations.map((c) => c.factId).sort()).toEqual(['a', 'b']);
    const aRow = pCitations.find((c) => c.factId === 'a');
    expect(aRow?.citedAtHash).toBe('h3');

    // Persona 'q' untouched
    expect(citationsStore.listForPersona('q')).toHaveLength(1);

    // Audit reason captures the drop count (2 = the older 'a' citations)
    const auditRows = auditStore.listForPersona('p');
    const pruneRow = auditRows.find((row) => row.stage === 'prune');
    expect(pruneRow?.reason).toContain('prune=dropped 2');
  });

  test('prune is idempotent — re-running drops zero', async () => {
    const { PersonaFactCitationsStore } = await import('../../../../src/db/persona-fact-citations-store.ts');
    const citationsStore = new PersonaFactCitationsStore(db);
    citationsStore.recordCitation({
      personaId: 'p',
      factId: 'a',
      citedAtHash: 'h1',
      taskId: 't1',
      phase: 'verify',
      claimExcerpt: 'x',
      citedAtTs: 100_000_000_000_000,
    });
    citationsStore.recordCitation({
      personaId: 'p',
      factId: 'a',
      citedAtHash: 'h2',
      taskId: 't2',
      phase: 'verify',
      claimExcerpt: 'x',
      citedAtTs: 100_000_000_000_001,
    });
    // First call: drops 1 superseded
    expect(citationsStore.pruneSupersededForPersona('p')).toBe(1);
    // Second call: nothing left to drop
    expect(citationsStore.pruneSupersededForPersona('p')).toBe(0);
  });

  test('replay scans recent traces and counts delusion-flagged outcomes', async () => {
    // Stub TraceStore-shape — real TraceStore couples to additional
    // schema columns that ALL_MIGRATIONS in :memory: tests doesn't ship
    // (pre-existing migration drift outside C4's scope). The regrounder
    // only consumes `findByAgent`, so a minimal stub is honest here.
    const seeded = [
      { id: 't1', delusionResult: { kind: 'delusion' as const, falsifiedCount: 1 } },
      { id: 't2' },
      { id: 't3', delusionResult: { kind: 'delusion' as const, falsifiedCount: 1 } },
    ];
    const traceStore = {
      findByAgent: () =>
        seeded.map((t) => ({
          id: t.id,
          taskId: t.id,
          timestamp: 1000,
          routingLevel: 1 as const,
          approach: 'a',
          oracleVerdicts: { ast: true },
          modelUsed: 'm',
          tokensConsumed: 0,
          durationMs: 0,
          outcome: 'success' as const,
          affectedFiles: [],
          ...(t.delusionResult ? { delusionResult: t.delusionResult } : {}),
        })),
      // biome-ignore lint/suspicious/noExplicitAny: stub for unused TraceStore methods
    } as any;

    const r = new RealityAnchorReGrounder({ bus, auditStore, traceStore });
    r.startRegrounding('p', 'test');

    const replayRow = auditStore.listForPersona('p').find((row) => row.stage === 'replay');
    expect(replayRow?.reason).toContain('replay=scanned 3');
    expect(replayRow?.reason).toContain('2 delusion-flagged');
  });

  test('replay reports skipped when traceStore is unwired', () => {
    const r = new RealityAnchorReGrounder({ bus, auditStore });
    r.startRegrounding('p', 'test');
    const replayRow = auditStore.listForPersona('p').find((row) => row.stage === 'replay');
    expect(replayRow?.reason).toContain('replay=skipped');
  });
});

describe('RealityAnchorReGrounder — defaults', () => {
  test('unseen persona is active', () => {
    const r = new RealityAnchorReGrounder({ bus, auditStore });
    expect(r.getState('researcher')).toBe('active');
    expect(r.canDispatch('researcher')).toBe(true);
  });
});

describe('RealityAnchorReGrounder — startRegrounding', () => {
  test('fires 4 audit stages (quarantine/rebuild/prune/replay) and lands in shadow-mode', () => {
    let now = 1000;
    const r = new RealityAnchorReGrounder({ bus, auditStore, clock: () => now++ });
    r.startRegrounding('researcher', 'manual op-trigger');
    expect(r.getState('researcher')).toBe('shadow-mode');
    expect(r.canDispatch('researcher')).toBe(true);

    const rows = auditStore.listForPersona('researcher');
    // listForPersona is newest-first; reverse for chronological.
    const stages = rows.map((row) => row.stage).reverse();
    // 4 audit rows on recovery start; the 5th stage 'reentry' fires
    // later when the persona graduates from shadow-mode back to active.
    expect(stages).toEqual(['quarantine', 'rebuild', 'prune', 'replay']);
  });

  test('audit timestamps are strictly monotonic per persona (no PK collision)', () => {
    // Clock returns the SAME value for all 4 calls — exercise the
    // monotonic-ts guard in nextTs.
    const r = new RealityAnchorReGrounder({ bus, auditStore, clock: () => 1000 });
    r.startRegrounding('researcher', 'r');
    const rows = auditStore.listForPersona('researcher');
    const ts = rows.map((row) => row.recordedAt).sort((a, b) => a - b);
    // All distinct
    expect(new Set(ts).size).toBe(ts.length);
    // 4 rows
    expect(ts).toHaveLength(4);
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
    expect(rows).toHaveLength(4);
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
    // 4 audit rows × 2 recovery cycles = 8 total
    expect(auditStore.listForPersona('p')).toHaveLength(8);
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
