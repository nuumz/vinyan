/**
 * Tests for GatewayIdentityStore — identity upsert + pairing tokens.
 *
 * Uses an in-memory SQLite with migration001 (base schema) + migration001
 * (Gateway tables). migration001 is not wired into `ALL_MIGRATIONS` yet —
 * the coordinator does that post-merge — so we instantiate the runner
 * manually here.
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { GatewayIdentityStore } from '../../src/db/gateway-identity-store.ts';
import { migration001 } from '../../src/db/migrations/001_initial_schema.ts';
import { MigrationRunner } from '../../src/db/migrations/migration-runner.ts';

let db: Database;
let store: GatewayIdentityStore;

beforeEach(() => {
  db = new Database(':memory:');
  new MigrationRunner().migrate(db, [migration001]);
  store = new GatewayIdentityStore(db);
});

afterEach(() => {
  db.close();
});

describe('upsertIdentity', () => {
  test('creates a new identity with a UUID gateway_user_id', () => {
    const res = store.upsertIdentity({
      profile: 'default',
      platform: 'telegram',
      platformUserId: '7',
      displayName: 'alice',
      trustTier: 'unknown',
      lastSeenMs: 100,
    });
    expect(res.isNew).toBe(true);
    expect(res.gatewayUserId).toMatch(/^[0-9a-f-]{36}$/);

    const row = store.getIdentity('telegram', '7');
    expect(row).not.toBeNull();
    expect(row!.displayName).toBe('alice');
    expect(row!.lastSeenAt).toBe(100);
    expect(row!.trustTier).toBe('unknown');
    expect(row!.pairedAt).toBeNull();
  });

  test('re-upserting the same (platform, platformUserId) returns the same id and updates last_seen', () => {
    const first = store.upsertIdentity({
      profile: 'default',
      platform: 'telegram',
      platformUserId: '7',
      displayName: 'alice',
      trustTier: 'unknown',
      lastSeenMs: 100,
    });
    const second = store.upsertIdentity({
      profile: 'default',
      platform: 'telegram',
      platformUserId: '7',
      trustTier: 'paired',
      lastSeenMs: 200,
    });
    expect(second.gatewayUserId).toBe(first.gatewayUserId);
    expect(second.isNew).toBe(false);

    const row = store.getIdentity('telegram', '7');
    expect(row!.lastSeenAt).toBe(200);
    // Tier is NOT mutated by upsert — only promoteToPaired changes it.
    expect(row!.trustTier).toBe('unknown');
  });

  test('two different platform_user_ids get different gateway_user_ids', () => {
    const a = store.upsertIdentity({
      profile: 'default',
      platform: 'telegram',
      platformUserId: '1',
      trustTier: 'unknown',
      lastSeenMs: 0,
    });
    const b = store.upsertIdentity({
      profile: 'default',
      platform: 'telegram',
      platformUserId: '2',
      trustTier: 'unknown',
      lastSeenMs: 0,
    });
    expect(a.gatewayUserId).not.toBe(b.gatewayUserId);
  });
});

describe('promoteToPaired', () => {
  test('updates trust_tier and stamps paired_at once', () => {
    const { gatewayUserId } = store.upsertIdentity({
      profile: 'default',
      platform: 'telegram',
      platformUserId: '7',
      trustTier: 'unknown',
      lastSeenMs: 0,
    });
    store.promoteToPaired(gatewayUserId, 555);
    const row = store.getIdentity('telegram', '7');
    expect(row!.trustTier).toBe('paired');
    expect(row!.pairedAt).toBe(555);

    // A later call does NOT overwrite the original paired_at.
    store.promoteToPaired(gatewayUserId, 999);
    const row2 = store.getIdentity('telegram', '7');
    expect(row2!.pairedAt).toBe(555);
  });
});

describe('pairing tokens', () => {
  test('issue + consume happy path', () => {
    const { token, expiresAt } = store.issuePairingToken({
      profile: 'default',
      platform: 'telegram',
      ttlMs: 60_000,
      nowMs: 1_000,
    });
    expect(token).toMatch(/^[0-9a-f]{24}$/);
    expect(expiresAt).toBe(61_000);

    const res = store.consumePairingToken({ token, consumedBy: 'user-x', nowMs: 10_000 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.row.consumedBy).toBe('user-x');
      expect(res.row.consumedAt).toBe(10_000);
    }
  });

  test('consume-twice returns already-consumed', () => {
    const { token } = store.issuePairingToken({
      profile: 'default',
      platform: 'telegram',
      ttlMs: 60_000,
      nowMs: 1_000,
    });
    const first = store.consumePairingToken({ token, consumedBy: 'u', nowMs: 2_000 });
    expect(first.ok).toBe(true);
    const second = store.consumePairingToken({ token, consumedBy: 'u', nowMs: 3_000 });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('already-consumed');
  });

  test('expired token returns expired', () => {
    const { token } = store.issuePairingToken({
      profile: 'default',
      platform: 'telegram',
      ttlMs: 10,
      nowMs: 1_000,
    });
    const res = store.consumePairingToken({ token, consumedBy: 'u', nowMs: 2_000 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('expired');
  });

  test('unknown token returns not-found', () => {
    const res = store.consumePairingToken({
      token: 'deadbeef',
      consumedBy: 'u',
      nowMs: 1,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('not-found');
  });

  test('tokens are single-use across two issued tokens', () => {
    const t1 = store.issuePairingToken({
      profile: 'default',
      platform: 'telegram',
      ttlMs: 60_000,
      nowMs: 0,
    });
    const t2 = store.issuePairingToken({
      profile: 'default',
      platform: 'telegram',
      ttlMs: 60_000,
      nowMs: 0,
    });
    expect(t1.token).not.toBe(t2.token);
    expect(store.consumePairingToken({ token: t1.token, consumedBy: 'a', nowMs: 1 }).ok).toBe(true);
    expect(store.consumePairingToken({ token: t2.token, consumedBy: 'b', nowMs: 1 }).ok).toBe(true);
  });
});
