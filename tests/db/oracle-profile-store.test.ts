import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { OracleProfileStore } from '../../src/db/oracle-profile-store.ts';
import { migration001 } from '../../src/db/migrations/001_initial_schema.ts';
function createDb(): Database {
  const db = new Database(':memory:');
  migration001.up(db);
  return db;
}

describe('OracleProfileStore', () => {
  let db: Database;
  let store: OracleProfileStore;

  beforeEach(() => {
    db = createDb();
    store = new OracleProfileStore(db);
  });

  test('createProfile creates a probation profile', () => {
    const profile = store.createProfile({ instanceId: 'peer-1', oracleName: 'type-oracle' });
    expect(profile.status).toBe('probation');
    expect(profile.instanceId).toBe('peer-1');
    expect(profile.oracleName).toBe('type-oracle');
    expect(profile.verdictsRequested).toBe(0);
    expect(profile.verdictsAccurate).toBe(0);
  });

  test('getProfile returns profile by instance+oracle', () => {
    store.createProfile({ instanceId: 'peer-1', oracleName: 'ast-oracle' });
    const found = store.getProfile('peer-1', 'ast-oracle');
    expect(found).not.toBeNull();
    expect(found!.oracleName).toBe('ast-oracle');
  });

  test('getProfile returns null for unknown', () => {
    expect(store.getProfile('unknown', 'unknown')).toBeNull();
  });

  test('recordResult increments accurate count on success', () => {
    const profile = store.createProfile({ instanceId: 'peer-1', oracleName: 'type-oracle' });
    store.recordResult(profile.id, true);
    store.recordResult(profile.id, true);

    const updated = store.getProfileById(profile.id)!;
    expect(updated.verdictsRequested).toBe(2);
    expect(updated.verdictsAccurate).toBe(2);
    expect(updated.falsePositiveCount).toBe(0);
  });

  test('recordResult increments false positive count on failure', () => {
    const profile = store.createProfile({ instanceId: 'peer-1', oracleName: 'type-oracle' });
    store.recordResult(profile.id, false);

    const updated = store.getProfileById(profile.id)!;
    expect(updated.verdictsRequested).toBe(1);
    expect(updated.falsePositiveCount).toBe(1);
    expect(updated.verdictsAccurate).toBe(0);
  });

  test('demote sets status and reason', () => {
    const profile = store.createProfile({ instanceId: 'peer-1', oracleName: 'type-oracle' });
    store.demote(profile.id, 'high false positive rate');

    const demoted = store.getProfileById(profile.id)!;
    expect(demoted.status).toBe('demoted');
    expect(demoted.demotionReason).toBe('high false positive rate');
    expect(demoted.demotedAt).toBeGreaterThan(0);
  });

  test('promote sets status to active', () => {
    const profile = store.createProfile({ instanceId: 'peer-1', oracleName: 'type-oracle' });
    store.promote(profile.id);

    const promoted = store.getProfileById(profile.id)!;
    expect(promoted.status).toBe('active');
  });

  test('retire sets status to retired', () => {
    const profile = store.createProfile({ instanceId: 'peer-1', oracleName: 'type-oracle' });
    store.retire(profile.id);

    const retired = store.getProfileById(profile.id)!;
    expect(retired.status).toBe('retired');
  });

  test('findByStatus returns profiles with matching status', () => {
    store.createProfile({ instanceId: 'peer-1', oracleName: 'type-oracle' });
    store.createProfile({ instanceId: 'peer-2', oracleName: 'type-oracle', status: 'active' });

    const probation = store.findByStatus('probation');
    const active = store.findByStatus('active');
    expect(probation.length).toBe(1);
    expect(active.length).toBe(1);
  });

  test('getProfilesByInstance returns all profiles for an instance', () => {
    store.createProfile({ instanceId: 'peer-1', oracleName: 'type-oracle' });
    store.createProfile({ instanceId: 'peer-1', oracleName: 'ast-oracle' });
    store.createProfile({ instanceId: 'peer-2', oracleName: 'type-oracle' });

    const peer1Profiles = store.getProfilesByInstance('peer-1');
    expect(peer1Profiles.length).toBe(2);
  });

  test('recordTimeout increments timeout count', () => {
    const profile = store.createProfile({ instanceId: 'peer-1', oracleName: 'slow-oracle' });
    store.recordTimeout(profile.id);
    store.recordTimeout(profile.id);

    const updated = store.getProfileById(profile.id)!;
    expect(updated.timeoutCount).toBe(2);
    expect(updated.verdictsRequested).toBe(2);
  });
});
