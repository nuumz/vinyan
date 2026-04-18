/**
 * FleetRegistry tests — unified read over three profile kinds with proper
 * weight mapping (active=1, probation=0.3, demoted=0, retired=0).
 */

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MigrationRunner, ALL_MIGRATIONS } from '../../../src/db/migrations/index.ts';
import { LocalOracleProfileStore } from '../../../src/db/local-oracle-profile-store.ts';
import { FleetRegistry, weightForStatus } from '../../../src/orchestrator/profile/fleet-registry.ts';

function freshDb(): Database {
  const db = new Database(':memory:');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  return db;
}

describe('weightForStatus', () => {
  test('maps each status to the advertised weight', () => {
    expect(weightForStatus('active')).toBe(1.0);
    expect(weightForStatus('probation')).toBe(0.3);
    expect(weightForStatus('demoted')).toBe(0.0);
    expect(weightForStatus('retired')).toBe(0.0);
    expect(weightForStatus(null)).toBe(0.0);
  });
});

describe('FleetRegistry — local oracle view', () => {
  test('listTrusted returns only active + probation with correct weights', () => {
    const db = freshDb();
    const store = new LocalOracleProfileStore(db);
    store.ensureProfile('ast', 'active');
    store.ensureProfile('type', 'probation');
    // Demote one
    const demotedId = store.ensureProfile('flaky', 'active').id;
    store.updateStatus(demotedId, 'demoted', 'bad');

    const registry = new FleetRegistry({ localOracleProfileStore: store });
    const trusted = registry.listTrusted('oracle-local');
    const ids = trusted.map((t) => t.id).sort();
    // Both active and probation are trusted; demoted is not
    expect(ids).toEqual([`local-oracle-ast`, `local-oracle-type`].sort());
    const byId = Object.fromEntries(trusted.map((t) => [t.id, t]));
    expect(byId[`local-oracle-ast`]!.weight).toBe(1.0);
    expect(byId[`local-oracle-type`]!.weight).toBe(0.3);
    db.close();
  });

  test('weightFor & statusFor round-trip', () => {
    const db = freshDb();
    const store = new LocalOracleProfileStore(db);
    const p = store.ensureProfile('ast', 'active');
    const registry = new FleetRegistry({ localOracleProfileStore: store });
    expect(registry.statusFor('oracle-local', p.id)).toBe('active');
    expect(registry.weightFor('oracle-local', p.id)).toBe(1.0);
    expect(registry.weightFor('oracle-local', 'unknown')).toBe(0);
    db.close();
  });
});

describe('FleetRegistry — empty deps', () => {
  test('returns empty list when store is absent', () => {
    const registry = new FleetRegistry({});
    expect(registry.listTrusted('worker')).toEqual([]);
    expect(registry.listTrusted('oracle-peer')).toEqual([]);
    expect(registry.listTrusted('oracle-local')).toEqual([]);
    expect(registry.getActiveWorkers()).toEqual([]);
  });
});
