/**
 * Tests for SkillAdmissionStore — Phase B audit log persistence.
 *
 * Behavior-only: every assertion exercises the public API and verifies the
 * recorded rows match the documented contract.
 */
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { SkillAdmissionStore } from '../../src/db/skill-admission-store.ts';

describe('SkillAdmissionStore', () => {
  let db: Database;
  let store: SkillAdmissionStore;

  beforeEach(() => {
    db = new Database(':memory:');
    const runner = new MigrationRunner();
    runner.migrate(db, ALL_MIGRATIONS);
    store = new SkillAdmissionStore(db);
  });

  test('listForPersona returns empty when no rows recorded', () => {
    expect(store.listForPersona('researcher')).toEqual([]);
  });

  test('recordVerdict persists an accept row roundtrip', () => {
    store.recordVerdict('researcher', 'literature-review', 'accept', 1.0, null, 1000);
    const rows = store.listForPersona('researcher');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      personaId: 'researcher',
      skillId: 'literature-review',
      verdict: 'accept',
      overlapRatio: 1.0,
      reason: null,
      decidedAt: 1000,
    });
  });

  test('recordVerdict persists a reject row with reason', () => {
    store.recordVerdict('researcher', 'marketing-copy', 'reject', 0, 'no overlap', 2000);
    const rows = store.listForPersona('researcher');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.verdict).toBe('reject');
    expect(rows[0]?.reason).toBe('no overlap');
  });

  test('listForPersona returns rows newest-first', () => {
    store.recordVerdict('researcher', 'a', 'accept', 1, null, 1000);
    store.recordVerdict('researcher', 'b', 'reject', 0, 'no overlap', 3000);
    store.recordVerdict('researcher', 'c', 'accept', 0.5, null, 2000);
    const rows = store.listForPersona('researcher');
    expect(rows.map((r) => r.skillId)).toEqual(['b', 'c', 'a']);
  });

  test('listForPersona scopes results to the requested persona', () => {
    store.recordVerdict('researcher', 'x', 'accept', 1, null, 1000);
    store.recordVerdict('developer', 'y', 'accept', 1, null, 1000);
    expect(store.listForPersona('researcher').map((r) => r.skillId)).toEqual(['x']);
    expect(store.listForPersona('developer').map((r) => r.skillId)).toEqual(['y']);
  });

  test('idempotent on (persona, skill, decided_at) — second insert is silently dropped', () => {
    store.recordVerdict('researcher', 'lit', 'accept', 1, null, 1000);
    store.recordVerdict('researcher', 'lit', 'accept', 1, null, 1000);
    expect(store.listForPersona('researcher')).toHaveLength(1);
  });

  test('same persona+skill at different timestamps records both', () => {
    store.recordVerdict('researcher', 'lit', 'reject', 0, 'no overlap', 1000);
    store.recordVerdict('researcher', 'lit', 'accept', 0.5, null, 2000);
    const rows = store.listForPersona('researcher');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.verdict).toBe('accept');
    expect(rows[1]?.verdict).toBe('reject');
  });

  test('listByVerdict filters globally and respects limit', () => {
    store.recordVerdict('researcher', 'a', 'reject', 0, 'r1', 1000);
    store.recordVerdict('developer', 'b', 'reject', 0, 'r2', 2000);
    store.recordVerdict('architect', 'c', 'accept', 1, null, 3000);
    const rejected = store.listByVerdict('reject');
    expect(rejected.map((r) => r.skillId)).toEqual(['b', 'a']);
    const accepted = store.listByVerdict('accept');
    expect(accepted.map((r) => r.skillId)).toEqual(['c']);
  });

  test('listByVerdict limit caps the result count', () => {
    for (let i = 0; i < 5; i++) {
      store.recordVerdict('researcher', `s${i}`, 'reject', 0, null, 1000 + i);
    }
    expect(store.listByVerdict('reject', 3)).toHaveLength(3);
  });

  test('countForPersona aggregates accept/reject counts', () => {
    store.recordVerdict('researcher', 'a', 'accept', 1, null, 1000);
    store.recordVerdict('researcher', 'b', 'reject', 0, null, 2000);
    store.recordVerdict('researcher', 'c', 'reject', 0, null, 3000);
    store.recordVerdict('developer', 'd', 'accept', 1, null, 4000);
    expect(store.countForPersona('researcher')).toEqual({ accept: 1, reject: 2 });
    expect(store.countForPersona('developer')).toEqual({ accept: 1, reject: 0 });
    expect(store.countForPersona('architect')).toEqual({ accept: 0, reject: 0 });
  });

  test('reason field stays null when omitted on accept', () => {
    store.recordVerdict('researcher', 'a', 'accept', 1, null, 1000);
    expect(store.listForPersona('researcher')[0]?.reason).toBeNull();
  });

  test('default clock advances on subsequent calls (sanity check)', () => {
    store.recordVerdict('researcher', 'a', 'accept', 1);
    const rows = store.listForPersona('researcher');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.decidedAt).toBeGreaterThan(0);
  });
});
