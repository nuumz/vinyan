/**
 * Tests for SkillOutcomeStore — Phase-3 per-(persona, skill, taskSig) outcomes.
 *
 * Covers:
 *   - record + get round-trip
 *   - increments via INSERT … ON CONFLICT path
 *   - listForPersona / listForSkill scans
 *   - wilsonLowerBound cold-start (n<10) returns 0.5
 *   - wilsonLowerBound on mature data is monotonic in success rate
 */
import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { SKILL_OUTCOME_SCHEMA_SQL } from '../../src/db/skill-outcome-schema.ts';
import { SkillOutcomeStore } from '../../src/db/skill-outcome-store.ts';
import { WILSON_COLD_START } from '../../src/orchestrator/capability-trust.ts';

function makeStore(): SkillOutcomeStore {
  const db = new Database(':memory:');
  db.exec(SKILL_OUTCOME_SCHEMA_SQL);
  return new SkillOutcomeStore(db);
}

const KEY = { personaId: 'developer', skillId: 'typescript-coding', taskSignature: 'refactor::ts' };

describe('SkillOutcomeStore', () => {
  test('record + get round-trip', () => {
    const store = makeStore();
    expect(store.getOutcome(KEY)).toBeNull();
    store.recordOutcome(KEY, 'success', 1000);
    const got = store.getOutcome(KEY);
    expect(got).not.toBeNull();
    expect(got!.successes).toBe(1);
    expect(got!.failures).toBe(0);
    expect(got!.lastOutcomeAt).toBe(1000);
  });

  test('repeated records increment counters via UPSERT', () => {
    const store = makeStore();
    for (let i = 0; i < 5; i++) store.recordOutcome(KEY, 'success', 1000 + i);
    for (let i = 0; i < 3; i++) store.recordOutcome(KEY, 'failure', 2000 + i);
    const got = store.getOutcome(KEY)!;
    expect(got.successes).toBe(5);
    expect(got.failures).toBe(3);
    expect(got.lastOutcomeAt).toBe(2002);
  });

  test('listForPersona returns rows for that persona only', () => {
    const store = makeStore();
    store.recordOutcome(KEY, 'success', 1000);
    store.recordOutcome({ ...KEY, skillId: 'react-patterns' }, 'success', 1100);
    store.recordOutcome({ ...KEY, personaId: 'author' }, 'success', 1200);
    const rows = store.listForPersona('developer');
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.personaId === 'developer')).toBe(true);
  });

  test('listForSkill returns rows for that skill across personas', () => {
    const store = makeStore();
    store.recordOutcome(KEY, 'success', 1000);
    store.recordOutcome({ ...KEY, personaId: 'reviewer' }, 'failure', 1100);
    const rows = store.listForSkill('typescript-coding');
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.skillId === 'typescript-coding')).toBe(true);
  });

  test('wilsonLowerBound returns cold-start neutral when n<10', () => {
    const store = makeStore();
    expect(store.wilsonLowerBound(KEY)).toBe(WILSON_COLD_START);
    for (let i = 0; i < 9; i++) store.recordOutcome(KEY, 'success', 1000 + i);
    expect(store.wilsonLowerBound(KEY)).toBe(WILSON_COLD_START);
  });

  test('wilsonLowerBound on mature data is monotonic in success rate', () => {
    const store = makeStore();
    // 20/20 successes
    for (let i = 0; i < 20; i++) store.recordOutcome(KEY, 'success', 1000 + i);
    const allSuccess = store.wilsonLowerBound(KEY);

    const otherKey = { ...KEY, taskSignature: 'mixed' };
    for (let i = 0; i < 10; i++) store.recordOutcome(otherKey, 'success', 1000 + i);
    for (let i = 0; i < 10; i++) store.recordOutcome(otherKey, 'failure', 1100 + i);
    const halfSuccess = store.wilsonLowerBound(otherKey);

    expect(allSuccess).toBeGreaterThan(halfSuccess);
    expect(halfSuccess).toBeLessThan(0.5);
    expect(allSuccess).toBeGreaterThan(0.7);
  });
});
