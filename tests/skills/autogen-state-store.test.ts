/**
 * R3 — restart-safe tracker contract.
 *
 * Verifies:
 *   - reconcile produces a fresh boot id and snapshots successes_at_boot
 *   - stale rows older than maxAgeMs are pruned at reconcile time
 *   - rows with state_version != 1 are invalidated
 *   - rows with corrupt task_ids_json are dropped
 *   - capacity cap drops oldest by last_seen
 *   - canPromote refuses when sinceBoot < MIN_POST_RESTART_EVIDENCE
 *   - canPromote refuses when cooldown still active
 *   - canPromote allows when threshold met + fresh evidence + no cooldown
 *   - recordSuccess increments durably and bounds taskIds at 25
 *   - recordEmit sets cooldown_until and last_emitted_at
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import {
  MAX_PERSISTED_TASK_IDS,
  MIN_POST_RESTART_EVIDENCE,
  SkillAutogenStateStore,
} from '../../src/skills/autogen-state-store.ts';

let db: Database;
let store: SkillAutogenStateStore;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  store = new SkillAutogenStateStore(db);
});

afterEach(() => {
  db.close();
});

describe('reconcile', () => {
  test('mints a fresh boot id and snapshots successes_at_boot', () => {
    // Seed two rows with successes > 0.
    db.run(
      `INSERT INTO skill_autogen_state
         (profile, signature_key, successes, successes_at_boot, last_seen,
          boot_id, cooldown_until, task_ids_json, state_version, last_emitted_at)
       VALUES ('p', 's1', 5, 0, ?, 'old-boot', 0, '["t1"]', 1, NULL)`,
      [Date.now() - 60_000],
    );
    db.run(
      `INSERT INTO skill_autogen_state
         (profile, signature_key, successes, successes_at_boot, last_seen,
          boot_id, cooldown_until, task_ids_json, state_version, last_emitted_at)
       VALUES ('p', 's2', 2, 0, ?, 'old-boot', 0, '["t2"]', 1, NULL)`,
      [Date.now() - 30_000],
    );

    const result = store.reconcile();
    expect(result.bootId).toBeDefined();
    expect(result.bootId).not.toBe('old-boot');
    expect(result.loaded).toBe(2);

    const r1 = store.get('p', 's1');
    expect(r1?.successes).toBe(5);
    expect(r1?.successesAtBoot).toBe(5);
    expect(r1?.bootId).toBe(result.bootId);
  });

  test('prunes rows older than maxAgeMs', () => {
    const shortTtl = 1_000; // 1 second
    const shortStore = new SkillAutogenStateStore(db, { maxAgeMs: shortTtl });
    db.run(
      `INSERT INTO skill_autogen_state
         (profile, signature_key, successes, successes_at_boot, last_seen,
          boot_id, cooldown_until, task_ids_json, state_version, last_emitted_at)
       VALUES ('p', 'fresh', 1, 0, ?, 'b', 0, '[]', 1, NULL)`,
      [Date.now()],
    );
    db.run(
      `INSERT INTO skill_autogen_state
         (profile, signature_key, successes, successes_at_boot, last_seen,
          boot_id, cooldown_until, task_ids_json, state_version, last_emitted_at)
       VALUES ('p', 'stale', 1, 0, ?, 'b', 0, '[]', 1, NULL)`,
      [Date.now() - 10_000],
    );
    const result = shortStore.reconcile();
    expect(result.prunedStale).toBe(1);
    expect(store.get('p', 'fresh')).not.toBeNull();
    expect(store.get('p', 'stale')).toBeNull();
  });

  test('invalidates rows with state_version != 1', () => {
    db.run(
      `INSERT INTO skill_autogen_state
         (profile, signature_key, successes, successes_at_boot, last_seen,
          boot_id, cooldown_until, task_ids_json, state_version, last_emitted_at)
       VALUES ('p', 'old-schema', 5, 0, ?, 'b', 0, '[]', 99, NULL)`,
      [Date.now()],
    );
    const result = store.reconcile();
    expect(result.invalidatedSchema).toBe(1);
    expect(store.get('p', 'old-schema')).toBeNull();
  });

  test('drops rows with corrupt task_ids_json', () => {
    db.run(
      `INSERT INTO skill_autogen_state
         (profile, signature_key, successes, successes_at_boot, last_seen,
          boot_id, cooldown_until, task_ids_json, state_version, last_emitted_at)
       VALUES ('p', 'corrupt', 1, 0, ?, 'b', 0, 'not-json', 1, NULL)`,
      [Date.now()],
    );
    const result = store.reconcile();
    expect(result.invalidatedCorrupt).toBe(1);
    expect(store.get('p', 'corrupt')).toBeNull();
  });

  test('capacity cap drops oldest by last_seen', () => {
    const capStore = new SkillAutogenStateStore(db, { maxRows: 3 });
    const base = Date.now();
    for (let i = 0; i < 5; i += 1) {
      db.run(
        `INSERT INTO skill_autogen_state
           (profile, signature_key, successes, successes_at_boot, last_seen,
            boot_id, cooldown_until, task_ids_json, state_version, last_emitted_at)
         VALUES ('p', ?, 1, 0, ?, 'b', 0, '[]', 1, NULL)`,
        [`s${i}`, base + i * 1000],
      );
    }
    const result = capStore.reconcile();
    // 5 rows, cap = 3 → 2 evicted by capacity.
    expect(result.prunedStale).toBeGreaterThanOrEqual(2);
    expect(store.get('p', 's0')).toBeNull();
    expect(store.get('p', 's1')).toBeNull();
    expect(store.get('p', 's4')).not.toBeNull();
  });
});

describe('canPromote — zero-trust gate', () => {
  test('refuses when sinceBoot < MIN_POST_RESTART_EVIDENCE', () => {
    const bootId = store.reconcile().bootId;
    const r = store.recordSuccess({
      profile: 'p',
      signatureKey: 'sig:fresh',
      bootId,
      taskId: 't1',
    });
    // Brand-new row: successes=1, successesAtBoot=1, sinceBoot=0.
    const verdict = store.canPromote(r, 2);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('fresh-evidence');
    expect(MIN_POST_RESTART_EVIDENCE).toBe(1);
  });

  test('refuses when cooldown_until is still in the future', () => {
    const bootId = store.reconcile().bootId;
    store.recordSuccess({ profile: 'p', signatureKey: 'sig:cool', bootId, taskId: 't1' });
    store.recordSuccess({ profile: 'p', signatureKey: 'sig:cool', bootId, taskId: 't2' });
    store.recordEmit({ profile: 'p', signatureKey: 'sig:cool', cooldownMs: 60_000 });
    const r = store.get('p', 'sig:cool')!;
    const verdict = store.canPromote(r, 2);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('cooldown');
  });

  test('refuses when successes < threshold', () => {
    const bootId = store.reconcile().bootId;
    store.recordSuccess({ profile: 'p', signatureKey: 'sig:few', bootId, taskId: 't1' });
    store.recordSuccess({ profile: 'p', signatureKey: 'sig:few', bootId, taskId: 't2' });
    const r = store.get('p', 'sig:few')!;
    const verdict = store.canPromote(r, 5);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('below-threshold');
  });

  test('allows when threshold met + fresh evidence + no cooldown', () => {
    const bootId = store.reconcile().bootId;
    // 2 successes — first creates with successesAtBoot=1, second bumps successes to 2.
    store.recordSuccess({ profile: 'p', signatureKey: 'sig:ok', bootId, taskId: 't1' });
    store.recordSuccess({ profile: 'p', signatureKey: 'sig:ok', bootId, taskId: 't2' });
    const r = store.get('p', 'sig:ok')!;
    expect(r.successes).toBe(2);
    expect(r.successesAtBoot).toBe(1);
    const verdict = store.canPromote(r, 2);
    expect(verdict.ok).toBe(true);
    expect(verdict.reason).toBeUndefined();
  });

  test('R3 invariant: pre-restart row with high successes does not promote on first emit', () => {
    // Simulate: previous run accumulated successes=5, then crashed.
    db.run(
      `INSERT INTO skill_autogen_state
         (profile, signature_key, successes, successes_at_boot, last_seen,
          boot_id, cooldown_until, task_ids_json, state_version, last_emitted_at)
       VALUES ('p', 'sig:carryover', 5, 0, ?, 'old-boot', 0, '["t1","t2","t3","t4","t5"]', 1, NULL)`,
      [Date.now() - 60_000],
    );
    const bootId = store.reconcile().bootId;
    // After reconcile, successesAtBoot was snapshotted to 5.
    const r = store.get('p', 'sig:carryover')!;
    expect(r.successes).toBe(5);
    expect(r.successesAtBoot).toBe(5);
    const verdict = store.canPromote(r, 3);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('fresh-evidence');

    // One additional success post-restart: successes=6, successesAtBoot=5,
    // sinceBoot=1 → promotion gate passes.
    const after = store.recordSuccess({
      profile: 'p',
      signatureKey: 'sig:carryover',
      bootId,
      taskId: 'post-restart',
    });
    const verdict2 = store.canPromote(after, 3);
    expect(verdict2.ok).toBe(true);
  });
});

describe('recordSuccess + recordEmit', () => {
  test('increments durably across calls', () => {
    const bootId = store.reconcile().bootId;
    store.recordSuccess({ profile: 'p', signatureKey: 'sig:inc', bootId, taskId: 't1' });
    store.recordSuccess({ profile: 'p', signatureKey: 'sig:inc', bootId, taskId: 't2' });
    store.recordSuccess({ profile: 'p', signatureKey: 'sig:inc', bootId, taskId: 't3' });
    const r = store.get('p', 'sig:inc')!;
    expect(r.successes).toBe(3);
    expect(r.taskIds).toEqual(['t1', 't2', 't3']);
  });

  test('taskIds bounded to MAX_PERSISTED_TASK_IDS', () => {
    const bootId = store.reconcile().bootId;
    for (let i = 0; i < 40; i += 1) {
      store.recordSuccess({
        profile: 'p',
        signatureKey: 'sig:ring',
        bootId,
        taskId: `t${i}`,
      });
    }
    const r = store.get('p', 'sig:ring')!;
    expect(r.taskIds.length).toBe(MAX_PERSISTED_TASK_IDS);
    // Newest entries retained.
    expect(r.taskIds[r.taskIds.length - 1]).toBe('t39');
  });

  test('recordEmit stamps cooldown_until and last_emitted_at', () => {
    const bootId = store.reconcile().bootId;
    store.recordSuccess({ profile: 'p', signatureKey: 'sig:emit', bootId, taskId: 't1' });
    const before = store.get('p', 'sig:emit')!;
    expect(before.cooldownUntil).toBe(0);
    expect(before.lastEmittedAt).toBeNull();

    store.recordEmit({ profile: 'p', signatureKey: 'sig:emit', cooldownMs: 5000 });
    const after = store.get('p', 'sig:emit')!;
    expect(after.cooldownUntil).toBeGreaterThan(0);
    expect(after.lastEmittedAt).toBeGreaterThan(0);
    expect(after.cooldownUntil - (after.lastEmittedAt ?? 0)).toBe(5000);
  });
});
