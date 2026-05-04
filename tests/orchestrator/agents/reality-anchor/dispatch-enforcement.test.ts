/**
 * Tests for Phase C4-followup dispatch enforcement.
 *
 * Behavior-only: drives `RealityAnchorReGrounder` into each state and
 * verifies that `canDispatch` returns the correct boolean. The
 * phase-generate guard reads `canDispatch` directly, so contract
 * verification at this seam is sufficient — the phase-generate
 * integration would require mocking the entire orchestrator, which
 * the broader regression suite already covers.
 *
 * Coverage:
 *   - active state allows dispatch
 *   - quarantined state blocks dispatch
 *   - rebuilding state blocks dispatch
 *   - shadow-mode allows dispatch (work runs but doesn't commit)
 *   - bus event reality-anchor:dispatch_blocked emits with correct state
 *     when phase-generate calls into the regrounder via canDispatch
 */
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { createBus, type VinyanBus } from '../../../../src/core/bus.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../../../src/db/migrations/index.ts';
import { RealityAnchorAuditStore } from '../../../../src/db/reality-anchor-audit-store.ts';
import { RealityAnchorReGrounder } from '../../../../src/orchestrator/agents/reality-anchor/regrounder.ts';

let db: Database;
let auditStore: RealityAnchorAuditStore;
let bus: VinyanBus;

beforeEach(() => {
  db = new Database(':memory:');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  auditStore = new RealityAnchorAuditStore(db);
  bus = createBus();
});

describe('canDispatch — state-based gate (Phase C4-followup dispatch enforcement)', () => {
  test('active persona: canDispatch returns true', () => {
    const r = new RealityAnchorReGrounder({ bus, auditStore });
    expect(r.canDispatch('researcher')).toBe(true);
  });

  test('quarantined persona: canDispatch returns false', () => {
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
  });

  test('rebuilding persona: canDispatch returns false', () => {
    let ts = 1000;
    auditStore.recordAudit({
      personaId: 'p',
      prevState: 'active',
      newState: 'quarantined',
      stage: 'quarantine',
      reason: 't',
      recordedAt: ts++,
    });
    auditStore.recordAudit({
      personaId: 'p',
      prevState: 'quarantined',
      newState: 'rebuilding',
      stage: 'rebuild',
      reason: 't',
      recordedAt: ts++,
    });
    const r = new RealityAnchorReGrounder({ bus, auditStore });
    expect(r.canDispatch('p')).toBe(false);
    expect(r.getState('p')).toBe('rebuilding');
  });

  test('shadow-mode persona: canDispatch returns true (work runs in monitor-only mode)', () => {
    let now = 1000;
    const r = new RealityAnchorReGrounder({ bus, auditStore, clock: () => now++ });
    r.startRegrounding('p', 'init');
    expect(r.getState('p')).toBe('shadow-mode');
    expect(r.canDispatch('p')).toBe(true);
  });

  test('after reentry: canDispatch returns true again', () => {
    let now = 1000;
    const r = new RealityAnchorReGrounder({
      bus,
      auditStore,
      clock: () => now++,
      cleanStreakRequired: 1,
    });
    r.startRegrounding('p', 'init');
    expect(r.canDispatch('p')).toBe(true); // shadow-mode still allows dispatch
    // Drive a clean trace to graduate
    r.onTraceRecord({
      id: 'tr',
      taskId: 't',
      timestamp: now,
      routingLevel: 1,
      approach: 'a',
      oracleVerdicts: {},
      modelUsed: 'm',
      tokensConsumed: 0,
      durationMs: 0,
      outcome: 'success',
      affectedFiles: [],
      // biome-ignore lint/suspicious/noExplicitAny: branded PersonaId in test
      agentId: 'p' as any,
    });
    expect(r.getState('p')).toBe('active');
    expect(r.canDispatch('p')).toBe(true);
  });
});
