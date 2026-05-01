/**
 * Tests for UserMdStore (migration 009).
 *
 * Covers:
 *   - Upsert creates a row; re-upsert replaces it.
 *   - Profile-scoped reads — data in profile A is invisible to profile B.
 *   - Rolling window returns the most recent N observations, oldest-first.
 *   - applyRevision patches only the supplied fields + bumps last_revised_at.
 *   - applyRevision on unknown slug returns false and leaves the store clean.
 *   - recordError + retrieval preserves turn_id when supplied.
 *   - deleteProfile clears both tables.
 */
import { Database } from 'bun:sqlite';
import { migration001 } from '../../src/db/migrations/001_initial_schema.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { UserMdStore } from '../../src/db/user-md-store.ts';

function freshDb(): Database {
  const db = new Database(':memory:');
  migration001.up(db);
  return db;
}

describe('UserMdStore', () => {
  let db: Database;
  let store: UserMdStore;

  beforeEach(() => {
    db = freshDb();
    store = new UserMdStore(db);
  });

  afterEach(() => {
    db.close();
  });

  test('upsertSection inserts, getSection reads it back', () => {
    store.upsertSection({
      profile: 'default',
      slug: 'communication-style',
      heading: 'Communication style',
      body: 'Terse replies.',
      predictedResponse: 'user prefers terse replies',
      evidenceTier: 'heuristic',
      confidence: 0.7,
    });
    const loaded = store.getSection('default', 'communication-style');
    expect(loaded).toBeDefined();
    expect(loaded!.heading).toBe('Communication style');
    expect(loaded!.predictedResponse).toBe('user prefers terse replies');
    expect(loaded!.evidenceTier).toBe('heuristic');
    expect(loaded!.lastRevisedAt).toBeUndefined();
  });

  test('upsertSection replaces on conflict (profile, slug)', () => {
    store.upsertSection({
      profile: 'default',
      slug: 'x',
      heading: 'X',
      body: 'first',
      predictedResponse: 'p1',
      evidenceTier: 'heuristic',
      confidence: 0.7,
    });
    store.upsertSection({
      profile: 'default',
      slug: 'x',
      heading: 'X',
      body: 'second',
      predictedResponse: 'p2',
      evidenceTier: 'probabilistic',
      confidence: 0.4,
      lastRevisedAt: 42,
    });
    const loaded = store.getSection('default', 'x');
    expect(loaded!.body).toBe('second');
    expect(loaded!.predictedResponse).toBe('p2');
    expect(loaded!.evidenceTier).toBe('probabilistic');
    expect(loaded!.lastRevisedAt).toBe(42);
  });

  test('getSections is profile-scoped', () => {
    store.upsertSection({
      profile: 'default',
      slug: 'a',
      heading: 'A',
      body: 'b',
      predictedResponse: 'p',
      evidenceTier: 'heuristic',
      confidence: 0.7,
    });
    store.upsertSection({
      profile: 'work',
      slug: 'b',
      heading: 'B',
      body: 'b',
      predictedResponse: 'p',
      evidenceTier: 'heuristic',
      confidence: 0.7,
    });
    expect(store.getSections('default').map((s) => s.slug)).toEqual(['a']);
    expect(store.getSections('work').map((s) => s.slug)).toEqual(['b']);
    expect(store.getSections('nonexistent')).toEqual([]);
  });

  test('recordError + rollingWindow return most-recent-N observations oldest-first', () => {
    const base = 1_700_000_000_000;
    for (let i = 0; i < 8; i++) {
      store.recordError({
        profile: 'default',
        slug: 'x',
        observed: `obs-${i}`,
        predicted: 'pred',
        delta: i * 0.1,
        turnId: `turn-${i}`,
        ts: base + i * 1_000,
      });
    }
    const window = store.rollingWindow('default', 'x', 5);
    expect(window.length).toBe(5);
    // Oldest-first: the caller feeds directly into applyDialectic.
    expect(window.map((w) => w.observed)).toEqual(['obs-3', 'obs-4', 'obs-5', 'obs-6', 'obs-7']);
    expect(window[0]!.turnId).toBe('turn-3');
  });

  test('rollingWindow is profile-scoped', () => {
    store.recordError({
      profile: 'default',
      slug: 'x',
      observed: 'default-obs',
      predicted: 'p',
      delta: 0.5,
      ts: 1,
    });
    store.recordError({
      profile: 'work',
      slug: 'x',
      observed: 'work-obs',
      predicted: 'p',
      delta: 0.9,
      ts: 2,
    });
    const defaultWindow = store.rollingWindow('default', 'x', 10);
    expect(defaultWindow).toHaveLength(1);
    expect(defaultWindow[0]!.observed).toBe('default-obs');

    const workWindow = store.rollingWindow('work', 'x', 10);
    expect(workWindow).toHaveLength(1);
    expect(workWindow[0]!.observed).toBe('work-obs');
  });

  test('applyRevision patches only supplied fields and stamps last_revised_at', () => {
    store.upsertSection({
      profile: 'default',
      slug: 'x',
      heading: 'X',
      body: 'body',
      predictedResponse: 'old',
      evidenceTier: 'heuristic',
      confidence: 0.7,
    });
    const updated = store.applyRevision('default', 'x', {
      predictedResponse: 'new',
      evidenceTier: 'probabilistic',
      lastRevisedAt: 123,
    });
    expect(updated).toBe(true);
    const loaded = store.getSection('default', 'x');
    expect(loaded!.predictedResponse).toBe('new');
    expect(loaded!.evidenceTier).toBe('probabilistic');
    expect(loaded!.confidence).toBe(0.7); // untouched
    expect(loaded!.body).toBe('body'); // untouched
    expect(loaded!.lastRevisedAt).toBe(123);
  });

  test('applyRevision returns false on unknown slug and does not create a row', () => {
    const updated = store.applyRevision('default', 'ghost', {
      predictedResponse: 'irrelevant',
      lastRevisedAt: 1,
    });
    expect(updated).toBe(false);
    expect(store.getSection('default', 'ghost')).toBeUndefined();
  });

  test('deleteProfile clears sections and errors but leaves other profiles intact', () => {
    store.upsertSection({
      profile: 'default',
      slug: 'x',
      heading: 'X',
      body: 'b',
      predictedResponse: 'p',
      evidenceTier: 'heuristic',
      confidence: 0.7,
    });
    store.recordError({
      profile: 'default',
      slug: 'x',
      observed: 'o',
      predicted: 'p',
      delta: 0.3,
      ts: 1,
    });
    store.upsertSection({
      profile: 'work',
      slug: 'y',
      heading: 'Y',
      body: 'b',
      predictedResponse: 'p',
      evidenceTier: 'heuristic',
      confidence: 0.7,
    });

    store.deleteProfile('default');
    expect(store.getSections('default')).toEqual([]);
    expect(store.rollingWindow('default', 'x', 10)).toEqual([]);
    expect(store.getSections('work').length).toBe(1);
  });
});
