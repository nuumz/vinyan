/**
 * Tests for `RealityAnchorAuditStore` — Phase C4 substrate.
 *
 * Behavior-only: every assertion exercises the public API and verifies
 * the documented contract.
 *
 * Coverage:
 *   - recordAudit: full-field roundtrip
 *   - composite-PK idempotency (same persona+ts → silent dup)
 *   - listForPersona: newest-first + limit
 *   - listRecent: newest-first across personas + limit
 *   - getLatestStateMap: one row per persona (the latest)
 *   - countByStageForPersona: aggregates correctly across all 5 stages
 */
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { RealityAnchorAuditStore } from '../../src/db/reality-anchor-audit-store.ts';

describe('RealityAnchorAuditStore', () => {
  let db: Database;
  let store: RealityAnchorAuditStore;

  beforeEach(() => {
    db = new Database(':memory:');
    new MigrationRunner().migrate(db, ALL_MIGRATIONS);
    store = new RealityAnchorAuditStore(db);
  });

  test('listForPersona returns empty when no rows recorded', () => {
    expect(store.listForPersona('researcher')).toEqual([]);
  });

  test('recordAudit persists with full-field roundtrip', () => {
    store.recordAudit({
      personaId: 'researcher',
      prevState: 'active',
      newState: 'quarantined',
      stage: 'quarantine',
      reason: 'psychosis:delusion=0.500>0.150',
      recordedAt: 1000,
    });
    const rows = store.listForPersona('researcher');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      personaId: 'researcher',
      prevState: 'active',
      newState: 'quarantined',
      stage: 'quarantine',
      reason: 'psychosis:delusion=0.500>0.150',
      recordedAt: 1000,
    });
  });

  test('idempotent on (persona_id, recorded_at) — duplicate insert silently dropped', () => {
    const input = {
      personaId: 'p',
      prevState: 'active' as const,
      newState: 'quarantined' as const,
      stage: 'quarantine' as const,
      reason: 'r',
      recordedAt: 1000,
    };
    store.recordAudit(input);
    store.recordAudit(input);
    expect(store.listForPersona('p')).toHaveLength(1);
  });

  test('listForPersona returns rows newest-first, scoped to persona', () => {
    store.recordAudit({
      personaId: 'p',
      prevState: 'active',
      newState: 'quarantined',
      stage: 'quarantine',
      reason: 'a',
      recordedAt: 1000,
    });
    store.recordAudit({
      personaId: 'p',
      prevState: 'quarantined',
      newState: 'rebuilding',
      stage: 'rebuild',
      reason: 'b',
      recordedAt: 2000,
    });
    store.recordAudit({
      personaId: 'q',
      prevState: 'active',
      newState: 'quarantined',
      stage: 'quarantine',
      reason: 'other',
      recordedAt: 1500,
    });
    const rows = store.listForPersona('p');
    expect(rows.map((r) => r.stage)).toEqual(['rebuild', 'quarantine']);
  });

  test('listForPersona honors the limit parameter', () => {
    for (let i = 0; i < 5; i++) {
      store.recordAudit({
        personaId: 'p',
        prevState: 'active',
        newState: 'quarantined',
        stage: 'quarantine',
        reason: `r${i}`,
        recordedAt: 1000 + i,
      });
    }
    expect(store.listForPersona('p', 3)).toHaveLength(3);
  });

  test('listRecent returns newest-first across personas', () => {
    store.recordAudit({
      personaId: 'p1',
      prevState: 'active',
      newState: 'quarantined',
      stage: 'quarantine',
      reason: 'r',
      recordedAt: 1000,
    });
    store.recordAudit({
      personaId: 'p2',
      prevState: 'active',
      newState: 'quarantined',
      stage: 'quarantine',
      reason: 'r',
      recordedAt: 3000,
    });
    store.recordAudit({
      personaId: 'p3',
      prevState: 'active',
      newState: 'quarantined',
      stage: 'quarantine',
      reason: 'r',
      recordedAt: 2000,
    });
    const rows = store.listRecent();
    expect(rows.map((r) => r.personaId)).toEqual(['p2', 'p3', 'p1']);
  });

  test('getLatestStateMap returns one row per persona (the latest)', () => {
    // Persona p walks through states; q walks through different states
    for (const [ts, prev, next, stage] of [
      [1000, 'active', 'quarantined', 'quarantine'],
      [2000, 'quarantined', 'rebuilding', 'rebuild'],
      [3000, 'rebuilding', 'shadow-mode', 'replay'],
    ] as const) {
      store.recordAudit({
        personaId: 'p',
        prevState: prev,
        newState: next,
        stage,
        reason: 'r',
        recordedAt: ts,
      });
    }
    store.recordAudit({
      personaId: 'q',
      prevState: 'active',
      newState: 'quarantined',
      stage: 'quarantine',
      reason: 'r',
      recordedAt: 1500,
    });
    const map = store.getLatestStateMap();
    expect(map.get('p')).toBe('shadow-mode');
    expect(map.get('q')).toBe('quarantined');
    expect(map.get('never-seen')).toBeUndefined();
  });

  test('countByStageForPersona aggregates across the 5 named stages', () => {
    const stages = ['quarantine', 'rebuild', 'prune', 'replay', 'reentry', 'replay'] as const;
    let ts = 1000;
    for (const stage of stages) {
      store.recordAudit({
        personaId: 'p',
        prevState: 'active',
        newState: 'active',
        stage,
        reason: 'r',
        recordedAt: ts++,
      });
    }
    expect(store.countByStageForPersona('p')).toEqual({
      quarantine: 1,
      rebuild: 1,
      prune: 1,
      replay: 2,
      reentry: 1,
    });
  });

  test('countByStageForPersona returns zeros for unknown persona', () => {
    expect(store.countByStageForPersona('ghost')).toEqual({
      quarantine: 0,
      rebuild: 0,
      prune: 0,
      replay: 0,
      reentry: 0,
    });
  });

  test('default recordedAt uses wall clock when omitted', () => {
    store.recordAudit({
      personaId: 'p',
      prevState: 'active',
      newState: 'quarantined',
      stage: 'quarantine',
      reason: 'r',
    });
    const rows = store.listForPersona('p');
    expect(rows[0]?.recordedAt).toBeGreaterThan(0);
  });
});
