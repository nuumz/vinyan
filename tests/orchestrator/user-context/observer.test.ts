/**
 * Tests for UserMdObserver (P3 USER.md dialectic wiring).
 *
 * Covers:
 *   - observeTurn on a section with clear prediction mismatch → high delta row.
 *   - observeTurn on matching text → low delta row.
 *   - Multiple sections → one prediction-error row per section.
 *   - Sections with empty / unknown-sentinel prediction are skipped.
 *   - Errors in store.recordError are swallowed (never throw out of observeTurn).
 *   - observeTurn on getSections failure degrades silently.
 *   - applyPending with window below threshold → [] and no revisions applied.
 *   - applyPending with deltas above revision threshold + no critic → demotes.
 *   - applyPending with critic → produces a revised update and persists it.
 *   - applyPending idempotent when no new observations arrive between calls.
 */
import { Database } from 'bun:sqlite';
import { migration001 } from '../../../src/db/migrations/001_initial_schema.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { UserMdStore } from '../../../src/db/user-md-store.ts';
import type { DialecticCritic } from '../../../src/orchestrator/user-context/dialectic.ts';
import { UserMdObserver } from '../../../src/orchestrator/user-context/observer.ts';
import { UNKNOWN_PREDICTION_TEXT } from '../../../src/orchestrator/user-context/user-md-schema.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function freshDb(): Database {
  const db = new Database(':memory:');
  migration001.up(db);
  return db;
}

function seedSection(
  store: UserMdStore,
  overrides: {
    slug: string;
    heading?: string;
    predictedResponse: string;
    evidenceTier?: 'deterministic' | 'heuristic' | 'probabilistic' | 'speculative';
    confidence?: number;
  },
  profile = 'default',
): void {
  store.upsertSection({
    profile,
    slug: overrides.slug,
    heading: overrides.heading ?? overrides.slug,
    body: 'body',
    predictedResponse: overrides.predictedResponse,
    evidenceTier: overrides.evidenceTier ?? 'heuristic',
    confidence: overrides.confidence ?? 0.7,
  });
}

// ---------------------------------------------------------------------------
// observeTurn
// ---------------------------------------------------------------------------

describe('UserMdObserver.observeTurn', () => {
  let db: Database;
  let store: UserMdStore;
  let observer: UserMdObserver;

  beforeEach(() => {
    db = freshDb();
    store = new UserMdStore(db);
    observer = new UserMdObserver({ store, profile: 'default' });
  });

  afterEach(() => {
    db.close();
  });

  test('mismatching text records a high delta row', () => {
    seedSection(store, { slug: 'style', predictedResponse: 'user prefers terse one-line replies' });
    observer.observeTurn({ turnId: 't1', userText: 'completely unrelated subject matter', ts: 100 });

    const window = store.rollingWindow('default', 'style', 10);
    expect(window).toHaveLength(1);
    expect(window[0]!.delta).toBeGreaterThan(0.5);
    expect(window[0]!.turnId).toBe('t1');
    expect(window[0]!.observed).toBe('completely unrelated subject matter');
  });

  test('matching text records a low delta row', () => {
    seedSection(store, { slug: 'style', predictedResponse: 'user prefers terse one-line replies' });
    observer.observeTurn({
      turnId: 't1',
      userText: 'user prefers terse one-line replies',
      ts: 100,
    });

    const window = store.rollingWindow('default', 'style', 10);
    expect(window).toHaveLength(1);
    expect(window[0]!.delta).toBe(0);
  });

  test('one row per active section with a prediction', () => {
    seedSection(store, { slug: 'a', predictedResponse: 'prediction alpha' });
    seedSection(store, { slug: 'b', predictedResponse: 'prediction beta' });
    observer.observeTurn({ turnId: 't1', userText: 'hello world', ts: 100 });

    expect(store.rollingWindow('default', 'a', 10)).toHaveLength(1);
    expect(store.rollingWindow('default', 'b', 10)).toHaveLength(1);
  });

  test('sections with empty prediction are skipped', () => {
    seedSection(store, { slug: 'skipme', predictedResponse: '' });
    seedSection(store, { slug: 'keep', predictedResponse: 'something' });
    observer.observeTurn({ turnId: 't1', userText: 'hello world', ts: 100 });

    expect(store.rollingWindow('default', 'skipme', 10)).toHaveLength(0);
    expect(store.rollingWindow('default', 'keep', 10)).toHaveLength(1);
  });

  test('sections flipped to unknown are skipped', () => {
    seedSection(store, { slug: 'unknown', predictedResponse: UNKNOWN_PREDICTION_TEXT });
    observer.observeTurn({ turnId: 't1', userText: 'hello', ts: 100 });
    expect(store.rollingWindow('default', 'unknown', 10)).toHaveLength(0);
  });

  test('recordError failure does not throw out of observeTurn', () => {
    seedSection(store, { slug: 'x', predictedResponse: 'pred' });
    const boomStore = new UserMdStore(db);
    // Monkey-patch recordError to throw; observer must swallow.
    boomStore.recordError = () => {
      throw new Error('boom');
    };
    // Preserve getSections by delegating.
    boomStore.getSections = (profile: string) => store.getSections(profile);

    const boomObserver = new UserMdObserver({ store: boomStore, profile: 'default' });
    expect(() => boomObserver.observeTurn({ turnId: 't1', userText: 'hello', ts: 100 })).not.toThrow();
  });

  test('getSections failure degrades silently', () => {
    const boomStore = new UserMdStore(db);
    boomStore.getSections = () => {
      throw new Error('no table');
    };
    const boomObserver = new UserMdObserver({ store: boomStore, profile: 'default' });
    expect(() => boomObserver.observeTurn({ turnId: 't1', userText: 'hello', ts: 100 })).not.toThrow();
  });

  test('profile-scoped: observer for profile A does not write rows for profile B', () => {
    seedSection(store, { slug: 'shared', predictedResponse: 'A prediction' }, 'profileA');
    seedSection(store, { slug: 'shared', predictedResponse: 'B prediction' }, 'profileB');
    const obsA = new UserMdObserver({ store, profile: 'profileA' });
    obsA.observeTurn({ turnId: 't1', userText: 'hello', ts: 100 });

    expect(store.rollingWindow('profileA', 'shared', 10)).toHaveLength(1);
    expect(store.rollingWindow('profileB', 'shared', 10)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// applyPending
// ---------------------------------------------------------------------------

describe('UserMdObserver.applyPending', () => {
  let db: Database;
  let store: UserMdStore;

  beforeEach(() => {
    db = freshDb();
    store = new UserMdStore(db);
  });

  afterEach(() => {
    db.close();
  });

  test('returns [] when no sections exist', async () => {
    const observer = new UserMdObserver({ store, profile: 'default' });
    expect(await observer.applyPending()).toEqual([]);
  });

  test('below revision threshold → all updates are none and nothing is persisted', async () => {
    seedSection(store, {
      slug: 'style',
      predictedResponse: 'user wants short replies',
      evidenceTier: 'heuristic',
      confidence: 0.7,
    });
    const observer = new UserMdObserver({ store, profile: 'default' });
    // Five near-perfect matches → rolling error well below 0.6.
    for (let i = 0; i < 5; i++) {
      observer.observeTurn({ turnId: `t${i}`, userText: 'user wants short replies', ts: 100 + i });
    }

    const updates = await observer.applyPending();
    expect(updates).toHaveLength(1);
    expect(updates[0]!.kind).toBe('none');
    const loaded = store.getSection('default', 'style');
    expect(loaded!.evidenceTier).toBe('heuristic');
    expect(loaded!.lastRevisedAt).toBeUndefined();
  });

  test('above revision threshold, no critic → demotes tier', async () => {
    // Partial overlap: prediction has 8 unique tokens; observation has 2 of
    // them plus 5 new ones → Jaccard ≈ 2 / 11 = 0.82 distance (between
    // revisionThreshold=0.6 and flipThreshold=0.85).
    seedSection(store, {
      slug: 'style',
      predictedResponse: 'user prefers verbose explanations with many detailed examples',
      evidenceTier: 'heuristic',
      confidence: 0.7,
    });
    const observer = new UserMdObserver({
      store,
      profile: 'default',
      clock: () => 10_000,
    });
    for (let i = 0; i < 5; i++) {
      observer.observeTurn({
        turnId: `t${i}`,
        userText: 'user prefers short replies with no examples',
        ts: 100 + i,
      });
    }

    const updates = await observer.applyPending();
    const demote = updates.find((u) => u.slug === 'style');
    expect(demote!.kind).toBe('demoted');
    const loaded = store.getSection('default', 'style');
    expect(loaded!.evidenceTier).toBe('probabilistic');
    expect(loaded!.lastRevisedAt).toBe(10_000);
    // Confidence dampened by the rule (~0.65 of prior).
    expect(loaded!.confidence).toBeLessThan(0.7);
  });

  test('above revision threshold with critic → revises with new prediction', async () => {
    seedSection(store, {
      slug: 'style',
      predictedResponse: 'user prefers verbose explanations with many detailed examples',
      evidenceTier: 'heuristic',
      confidence: 0.7,
    });
    const critic: DialecticCritic = async () => ({
      newPrediction: 'user prefers concise answers',
      confidence: 0.6,
    });
    const observer = new UserMdObserver({
      store,
      profile: 'default',
      critic,
      clock: () => 20_000,
    });
    for (let i = 0; i < 5; i++) {
      observer.observeTurn({
        turnId: `t${i}`,
        userText: 'user prefers short replies with no examples',
        ts: 100 + i,
      });
    }

    const updates = await observer.applyPending();
    const revise = updates.find((u) => u.slug === 'style');
    expect(revise!.kind).toBe('revised');
    const loaded = store.getSection('default', 'style');
    expect(loaded!.predictedResponse).toBe('user prefers concise answers');
    expect(loaded!.evidenceTier).toBe('probabilistic');
    expect(loaded!.lastRevisedAt).toBe(20_000);
  });

  test('idempotent when no new observations arrive between calls', async () => {
    seedSection(store, {
      slug: 'style',
      predictedResponse: 'user wants short replies',
      evidenceTier: 'heuristic',
      confidence: 0.7,
    });
    const observer = new UserMdObserver({ store, profile: 'default', clock: () => 1 });
    for (let i = 0; i < 5; i++) {
      observer.observeTurn({ turnId: `t${i}`, userText: 'user wants short replies', ts: 100 + i });
    }

    const first = await observer.applyPending();
    const secondClock = { now: 999 };
    const observer2 = new UserMdObserver({ store, profile: 'default', clock: () => secondClock.now });
    const second = await observer2.applyPending();

    // Kinds identical across calls (none).
    expect(first.map((u) => u.kind)).toEqual(second.map((u) => u.kind));
    // Store untouched (no persisted revision).
    const loaded = store.getSection('default', 'style');
    expect(loaded!.lastRevisedAt).toBeUndefined();
  });
});
