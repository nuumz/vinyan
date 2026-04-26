/**
 * Tests for setupUserMdObserver (P3 wiring helper).
 *
 * Covers:
 *   - Returns a working observer + store pair bound to the same DB.
 *   - Independence: two handles built from the same DB but different profiles
 *     do not cross-contaminate.
 *   - MigrationRunner path: fresh :memory: DB with all migrations boots cleanly.
 *   - Threshold overrides propagate through to the dialectic rule.
 *   - Store accessor returns the same instance that backs the observer.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { ALL_MIGRATIONS, MigrationRunner } from '../../../src/db/migrations/index.ts';
import { UserMdStore } from '../../../src/db/user-md-store.ts';
import type { DialecticCritic } from '../../../src/orchestrator/user-context/dialectic.ts';
import { UserMdObserver } from '../../../src/orchestrator/user-context/observer.ts';
import { setupUserMdObserver } from '../../../src/orchestrator/user-context/wiring.ts';

function seedSection(store: UserMdStore, profile: string, slug: string, prediction: string): void {
  store.upsertSection({
    profile,
    slug,
    heading: slug,
    body: 'body',
    predictedResponse: prediction,
    evidenceTier: 'heuristic',
    confidence: 0.7,
  });
}

describe('setupUserMdObserver', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  });

  afterEach(() => {
    db.close();
  });

  test('returns a working observer + store handle', () => {
    const handle = setupUserMdObserver({ db, profile: 'default' });
    expect(handle.observer).toBeInstanceOf(UserMdObserver);
    expect(handle.store).toBeInstanceOf(UserMdStore);

    seedSection(handle.store, 'default', 'style', 'user likes it brief');
    handle.observer.observeTurn({ turnId: 't1', userText: 'totally different thing', ts: 100 });

    const window = handle.store.rollingWindow('default', 'style', 10);
    expect(window).toHaveLength(1);
    expect(window[0]!.turnId).toBe('t1');
  });

  test('profile isolation: two handles do not cross-contaminate', () => {
    const a = setupUserMdObserver({ db, profile: 'profileA' });
    const b = setupUserMdObserver({ db, profile: 'profileB' });

    seedSection(a.store, 'profileA', 'shared', 'A prediction');
    seedSection(b.store, 'profileB', 'shared', 'B prediction');

    a.observer.observeTurn({ turnId: 'tA', userText: 'hello', ts: 1 });
    expect(a.store.rollingWindow('profileA', 'shared', 10)).toHaveLength(1);
    expect(b.store.rollingWindow('profileB', 'shared', 10)).toHaveLength(0);
  });

  test('MigrationRunner applies 009 via ALL_MIGRATIONS so the handle boots cleanly', () => {
    // Fresh DB already migrated in beforeEach — any subsequent call is a no-op.
    const runner = new MigrationRunner();
    const second = runner.migrate(db, ALL_MIGRATIONS);
    expect(second.applied).toEqual([]);

    // Handle must still function.
    const handle = setupUserMdObserver({ db, profile: 'default' });
    seedSection(handle.store, 'default', 'z', 'predicted');
    expect(() => handle.observer.observeTurn({ turnId: 't1', userText: 'observed', ts: 1 })).not.toThrow();
  });

  test('threshold overrides propagate to applyPending (flip override)', async () => {
    // Use an aggressive flipThreshold so a rolling 0.5 mean would still flip.
    const handle = setupUserMdObserver({
      db,
      profile: 'default',
      thresholds: { flipThreshold: 0.0001, revisionThreshold: 0.00005, windowSize: 5 },
    });
    seedSection(handle.store, 'default', 'style', 'user wants concise replies');
    for (let i = 0; i < 5; i++) {
      handle.observer.observeTurn({
        turnId: `t${i}`,
        userText: 'completely unrelated terms with novel vocabulary',
        ts: 100 + i,
      });
    }
    const updates = await handle.observer.applyPending();
    expect(updates[0]!.kind).toBe('flipped-to-unknown');
  });

  test('critic override reaches the dialectic rule via applyPending', async () => {
    const calls: Array<{ observedCount: number }> = [];
    const critic: DialecticCritic = async (_section, observed) => {
      calls.push({ observedCount: observed.length });
      return { newPrediction: 'revised text', confidence: 0.4 };
    };
    const handle = setupUserMdObserver({
      db,
      profile: 'default',
      critic,
      thresholds: { revisionThreshold: 0.1, flipThreshold: 0.99, windowSize: 3 },
    });
    // Share one token ("prediction") so Jaccard distance stays below the
    // flipThreshold=0.99 while still clearing the revisionThreshold=0.1.
    seedSection(handle.store, 'default', 'style', 'original prediction');
    for (let i = 0; i < 3; i++) {
      handle.observer.observeTurn({
        turnId: `t${i}`,
        userText: 'mostly different prediction entirely',
        ts: 100 + i,
      });
    }

    const updates = await handle.observer.applyPending();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.observedCount).toBe(3);
    expect(updates[0]!.kind).toBe('revised');
    const loaded = handle.store.getSection('default', 'style');
    expect(loaded!.predictedResponse).toBe('revised text');
  });
});
