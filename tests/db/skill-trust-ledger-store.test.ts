/**
 * SkillTrustLedgerStore tests — migration 008 + profile-scoped read/write.
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { migration008 } from '../../src/db/migrations/008_skill_trust_ledger.ts';
import { SkillTrustLedgerStore, type SkillTrustLedgerRecord } from '../../src/db/skill-trust-ledger-store.ts';

function makeDb(): Database {
  const db = new Database(':memory:');
  migration008.up(db);
  return db;
}

function makeRecord(overrides: Partial<SkillTrustLedgerRecord> = {}): SkillTrustLedgerRecord {
  return {
    profile: 'default',
    skillId: 'refactor/extract-method-ts',
    event: 'fetched',
    evidence: { adapter: 'github' },
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

describe('SkillTrustLedgerStore', () => {
  let db: Database;
  let store: SkillTrustLedgerStore;

  beforeEach(() => {
    db = makeDb();
    store = new SkillTrustLedgerStore(db);
  });

  test('record inserts a row and returns the autoincrement id', () => {
    const id = store.record(makeRecord());
    expect(id).toBeGreaterThan(0);

    const row = db.prepare('SELECT COUNT(*) as c FROM skill_trust_ledger').get() as { c: number };
    expect(row.c).toBe(1);
  });

  test('record stores evidence as JSON', () => {
    store.record(makeRecord({ evidence: { adapter: 'github', contentHash: 'sha256:abc' } }));

    const row = db.prepare('SELECT evidence_json FROM skill_trust_ledger LIMIT 1').get() as { evidence_json: string };
    expect(JSON.parse(row.evidence_json)).toEqual({
      adapter: 'github',
      contentHash: 'sha256:abc',
    });
  });

  test('history returns rows oldest-first for the requested profile', () => {
    store.record(makeRecord({ createdAt: 100 }));
    store.record(makeRecord({ event: 'scanned', createdAt: 200 }));
    store.record(makeRecord({ profile: 'work', event: 'scanned', createdAt: 150 }));

    const defaults = store.history('refactor/extract-method-ts', { profile: 'default' });
    expect(defaults.length).toBe(2);
    expect(defaults[0]?.event).toBe('fetched');
    expect(defaults[1]?.event).toBe('scanned');

    const work = store.history('refactor/extract-method-ts', { profile: 'work' });
    expect(work.length).toBe(1);
    expect(work[0]?.profile).toBe('work');
  });

  test("history with profile='ALL' returns rows across profiles", () => {
    store.record(makeRecord({ createdAt: 100 }));
    store.record(makeRecord({ profile: 'other', createdAt: 150 }));
    const rows = store.history('refactor/extract-method-ts', { profile: 'ALL' });
    expect(rows.length).toBe(2);
  });

  test('history ignores rows for other skill ids', () => {
    store.record(makeRecord());
    store.record(makeRecord({ skillId: 'other/skill' }));
    const rows = store.history('refactor/extract-method-ts', { profile: 'default' });
    expect(rows.length).toBe(1);
    expect(rows[0]?.skillId).toBe('refactor/extract-method-ts');
  });

  test('latest returns the most-recent event for a skill/profile', () => {
    store.record(makeRecord({ createdAt: 100 }));
    store.record(makeRecord({ event: 'promoted', createdAt: 300, toTier: 'probabilistic' }));
    store.record(makeRecord({ event: 'scanned', createdAt: 200 }));

    const latest = store.latest('refactor/extract-method-ts', { profile: 'default' });
    expect(latest?.event).toBe('promoted');
    expect(latest?.toTier).toBe('probabilistic');
  });

  test('latest returns null when no rows exist for the profile', () => {
    store.record(makeRecord({ profile: 'other' }));
    const latest = store.latest('refactor/extract-method-ts', { profile: 'default' });
    expect(latest).toBeNull();
  });

  test('listByProfile returns rows most-recent-first', () => {
    store.record(makeRecord({ createdAt: 100 }));
    store.record(makeRecord({ event: 'scanned', createdAt: 200 }));
    store.record(makeRecord({ skillId: 'other/skill', event: 'promoted', createdAt: 300 }));

    const rows = store.listByProfile('default');
    expect(rows.length).toBe(3);
    expect(rows[0]?.createdAt).toBe(300);
    expect(rows[2]?.createdAt).toBe(100);
  });

  test('optional fields round-trip through record → history', () => {
    store.record(
      makeRecord({
        event: 'promoted',
        fromStatus: 'quarantined',
        toStatus: 'active',
        fromTier: 'speculative',
        toTier: 'heuristic',
        ruleId: 'hub-import-v1',
      }),
    );
    const [row] = store.history('refactor/extract-method-ts', { profile: 'default' });
    expect(row?.fromStatus).toBe('quarantined');
    expect(row?.toStatus).toBe('active');
    expect(row?.fromTier).toBe('speculative');
    expect(row?.toTier).toBe('heuristic');
    expect(row?.ruleId).toBe('hub-import-v1');
  });
});
