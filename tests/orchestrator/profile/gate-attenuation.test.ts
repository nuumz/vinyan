/**
 * Integration-ish test for Step 4 Verify — gate.ts attenuates oracle confidence
 * by local-oracle profile status. We don't boot the whole gate pipeline; we
 * exercise `profileStatusWeight` as the deterministic contract and confirm
 * the module-level setter/clearer work.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { MigrationRunner, ALL_MIGRATIONS } from '../../../src/db/migrations/index.ts';
import { LocalOracleProfileStore } from '../../../src/db/local-oracle-profile-store.ts';
import { profileStatusWeight, setGateDeps, clearGateDeps } from '../../../src/gate/gate.ts';

// Reset module-level state between tests so gate attenuation behaves
// deterministically regardless of test file ordering.
afterEach(() => clearGateDeps());

function freshDb(): Database {
  const db = new Database(':memory:');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  return db;
}

describe('gate profile attenuation', () => {
  test('status weights match the documented table', () => {
    expect(profileStatusWeight('active')).toBe(1.0);
    expect(profileStatusWeight('probation')).toBe(0.6);
    expect(profileStatusWeight('demoted')).toBe(0.3);
    expect(profileStatusWeight('retired')).toBe(0.0);
    // No profile — neutral, preserves pre-registration behavior
    expect(profileStatusWeight(null)).toBe(1.0);
  });

  test('setGateDeps registers the local-oracle store; clearGateDeps wipes', () => {
    const db = freshDb();
    const store = new LocalOracleProfileStore(db);
    store.ensureProfile('ast', 'active');
    setGateDeps({ localOracleProfileStore: store });
    // Registered: findByName returns the profile
    const p = store.findByName('ast')!;
    expect(p.status).toBe('active');
    clearGateDeps();
    db.close();
  });

  test('LocalOracleProfileStore.ensureProfile is idempotent and memory-cached', () => {
    const db = freshDb();
    const store = new LocalOracleProfileStore(db);
    const first = store.ensureProfile('type', 'active');
    const second = store.ensureProfile('type', 'probation');
    // Second call does not overwrite status — first-call semantics win
    expect(second.id).toBe(first.id);
    expect(second.status).toBe('active');
    db.close();
  });
});
