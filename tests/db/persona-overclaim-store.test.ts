/**
 * Phase-14 (Item 3) — `PersonaOverclaimStore` SQLite persistence layer.
 *
 * Covers:
 *   - bootstrap from migration runner builds the table
 *   - recordObservation/recordOverclaim INSERT then UPDATE on PK conflict
 *   - getRecord returns the persisted shape; null when unknown
 *   - listAll snapshots all rows; ordered deterministically
 *   - tracker rehydration: store survives a fresh tracker instance
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { PERSONA_OVERCLAIM_SCHEMA_SQL } from '../../src/db/persona-overclaim-schema.ts';
import { PersonaOverclaimStore } from '../../src/db/persona-overclaim-store.ts';
import { PersonaOverclaimTracker } from '../../src/economy/market/persona-overclaim-tracker.ts';

function makeStore(): { store: PersonaOverclaimStore; db: Database } {
  const db = new Database(':memory:');
  db.exec(PERSONA_OVERCLAIM_SCHEMA_SQL);
  return { store: new PersonaOverclaimStore(db), db };
}

describe('PersonaOverclaimStore', () => {
  test('unknown persona → getRecord null', () => {
    const { store } = makeStore();
    expect(store.getRecord('developer')).toBeNull();
  });

  test('recordObservation INSERTs then UPDATEs on conflict', () => {
    const { store } = makeStore();
    store.recordObservation('developer', 1000);
    store.recordObservation('developer', 2000);
    const r = store.getRecord('developer');
    expect(r).not.toBeNull();
    expect(r!.observations).toBe(2);
    expect(r!.overclaims).toBe(0);
    expect(r!.lastUpdated).toBe(2000);
  });

  test('recordOverclaim accumulates independently', () => {
    const { store } = makeStore();
    store.recordObservation('developer', 1000);
    store.recordOverclaim('developer', 1500);
    store.recordOverclaim('developer', 2000);
    const r = store.getRecord('developer');
    expect(r!.observations).toBe(1);
    expect(r!.overclaims).toBe(2);
    expect(r!.lastUpdated).toBe(2000);
  });

  test('personas are isolated', () => {
    const { store } = makeStore();
    store.recordObservation('developer', 1);
    store.recordOverclaim('developer', 2);
    store.recordObservation('reviewer', 3);
    expect(store.getRecord('developer')).toEqual({
      personaId: 'developer',
      observations: 1,
      overclaims: 1,
      lastUpdated: 2,
    });
    expect(store.getRecord('reviewer')).toEqual({
      personaId: 'reviewer',
      observations: 1,
      overclaims: 0,
      lastUpdated: 3,
    });
  });

  test('listAll returns every row, ordered by persona_id ASC', () => {
    const { store } = makeStore();
    store.recordObservation('reviewer', 1);
    store.recordObservation('developer', 1);
    store.recordObservation('architect', 1);
    const all = store.listAll();
    expect(all.map((r) => r.personaId)).toEqual(['architect', 'developer', 'reviewer']);
  });
});

describe('PersonaOverclaimTracker — restart-replay (Phase-14 Item 3)', () => {
  test('tracker rehydrates from store on construction', () => {
    const { store } = makeStore();
    // Simulate a prior orchestrator that recorded plenty before restart.
    for (let i = 0; i < 20; i++) store.recordObservation('developer', i);
    for (let i = 0; i < 5; i++) store.recordOverclaim('developer', i);

    // New tracker (e.g. after restart) reads the existing store.
    const tracker = new PersonaOverclaimTracker(store);
    expect(tracker.getRecord('developer')).toEqual({ observations: 20, overclaims: 5 });
    expect(tracker.getOverclaimRatio('developer')).toBe(0.25);
    expect(tracker.getPenaltyMultiplier('developer')).toBe(0.75);
  });

  test('writes flow through tracker → store', () => {
    const { store } = makeStore();
    const tracker = new PersonaOverclaimTracker(store);
    tracker.recordObservation('developer');
    tracker.recordOverclaim('developer');
    const persisted = store.getRecord('developer');
    expect(persisted!.observations).toBe(1);
    expect(persisted!.overclaims).toBe(1);
  });

  test('counters survive tracker re-instantiation against the same store', () => {
    const { store } = makeStore();
    const t1 = new PersonaOverclaimTracker(store);
    for (let i = 0; i < 12; i++) t1.recordObservation('developer');
    for (let i = 0; i < 3; i++) t1.recordOverclaim('developer');

    // Drop t1, simulate restart
    const t2 = new PersonaOverclaimTracker(store);
    expect(t2.getRecord('developer')).toEqual({ observations: 12, overclaims: 3 });
    // 3/12 = 25% → past cold-start (≥10) → 0.75 multiplier
    expect(t2.getPenaltyMultiplier('developer')).toBe(0.75);
  });

  test('tracker without persistence still works (legacy / minimal setup)', () => {
    const tracker = new PersonaOverclaimTracker();
    tracker.recordObservation('developer');
    expect(tracker.getRecord('developer')).toEqual({ observations: 1, overclaims: 0 });
  });

  test('persistence rehydration failure degrades to in-memory (A9 best-effort)', () => {
    const failingStore = {
      recordObservation: () => {},
      recordOverclaim: () => {},
      listAll: () => {
        throw new Error('boom');
      },
    };
    // Construction must not throw
    const tracker = new PersonaOverclaimTracker(failingStore);
    tracker.recordObservation('developer');
    // In-memory state still updates
    expect(tracker.getRecord('developer')).toEqual({ observations: 1, overclaims: 0 });
  });

  test('persistence write failure does not propagate (A9)', () => {
    const failingStore = {
      recordObservation: () => {
        throw new Error('boom');
      },
      recordOverclaim: () => {
        throw new Error('boom');
      },
      listAll: () => [],
    };
    const tracker = new PersonaOverclaimTracker(failingStore);
    expect(() => tracker.recordObservation('developer')).not.toThrow();
    expect(() => tracker.recordOverclaim('developer')).not.toThrow();
    // In-memory counters still tick
    expect(tracker.getRecord('developer')).toEqual({ observations: 1, overclaims: 1 });
  });
});
