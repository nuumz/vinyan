/**
 * Tests for ComprehensionStore — SQLite round-trips, outcome lifecycle,
 * session + engine queries, stale sweep, idempotency guarantees.
 */

import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ComprehensionStore } from '../../src/db/comprehension-store.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import type { ComprehendedTaskMessage } from '../../src/orchestrator/comprehension/types.ts';

let db: Database;
let store: ComprehensionStore;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  store = new ComprehensionStore(db);
});

afterEach(() => {
  db.close();
});

/** Minimal valid envelope for round-trip tests. */
function envelope(overrides: Partial<{
  inputHash: string;
  tier: 'deterministic' | 'heuristic' | 'probabilistic' | 'unknown';
  type: 'comprehension' | 'unknown';
  confidence: number;
  rootGoal: string | null;
}> = {}): ComprehendedTaskMessage {
  return {
    jsonrpc: '2.0',
    method: 'comprehension.result',
    params: {
      type: overrides.type ?? 'comprehension',
      confidence: overrides.confidence ?? 1,
      tier: overrides.tier ?? 'deterministic',
      evidence_chain: [
        { source: 'rule:session-history', claim: 'test evidence', confidence: 1 },
      ],
      falsifiable_by: ['user-next-turn'],
      temporal_context: { as_of: Date.now() },
      inputHash: overrides.inputHash ?? 'abc123',
      rootGoal: overrides.rootGoal ?? null,
      data: {
        literalGoal: 'test goal',
        resolvedGoal: 'test goal',
        state: {
          isNewTopic: true,
          isClarificationAnswer: false,
          isFollowUp: false,
          hasAmbiguousReferents: false,
          pendingQuestions: [],
          rootGoal: overrides.rootGoal ?? null,
        },
        priorContextSummary: 'empty',
        memoryLaneRelevance: {},
      },
    },
  };
}

describe('ComprehensionStore', () => {
  test('record inserts a new row and returns true', () => {
    const inserted = store.record({
      envelope: envelope(),
      taskId: 't-1',
      sessionId: 's-1',
      engineId: 'rule-comprehender',
      engineType: 'rule',
      verdictPass: true,
    });
    expect(inserted).toBe(true);
    expect(store.count()).toBe(1);
  });

  test('record is idempotent on same inputHash (A4 content-addressed)', () => {
    const env = envelope({ inputHash: 'dup' });
    const first = store.record({
      envelope: env,
      taskId: 't-1',
      sessionId: 's-1',
      engineId: 'rule-comprehender',
      engineType: 'rule',
      verdictPass: true,
    });
    const second = store.record({
      envelope: env,
      taskId: 't-2',
      sessionId: 's-1',
      engineId: 'rule-comprehender',
      engineType: 'rule',
      verdictPass: true,
    });
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(store.count()).toBe(1);
  });

  test('mostRecentForSession returns newest first', () => {
    const now = Date.now();
    store.record({
      envelope: envelope({ inputHash: 'h1' }),
      taskId: 't-1',
      sessionId: 's-1',
      engineId: 'rule-comprehender',
      engineType: 'rule',
      verdictPass: true,
      createdAt: now - 2000,
    });
    store.record({
      envelope: envelope({ inputHash: 'h2' }),
      taskId: 't-2',
      sessionId: 's-1',
      engineId: 'rule-comprehender',
      engineType: 'rule',
      verdictPass: true,
      createdAt: now - 1000,
    });
    store.record({
      envelope: envelope({ inputHash: 'h3' }),
      taskId: 't-3',
      sessionId: 's-1',
      engineId: 'rule-comprehender',
      engineType: 'rule',
      verdictPass: false,
      verdictReason: 'engine lied',
      createdAt: now,
    });

    const rows = store.mostRecentForSession('s-1', 10);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.input_hash)).toEqual(['h3', 'h2', 'h1']);
    expect(rows[0]!.verdict_pass).toBe(0);
    expect(rows[0]!.verdict_reason).toBe('engine lied');
  });

  test('mostRecentForSession filters by session', () => {
    store.record({
      envelope: envelope({ inputHash: 'a' }),
      taskId: 't',
      sessionId: 's-1',
      engineId: 'rule-comprehender',
      engineType: 'rule',
      verdictPass: true,
    });
    store.record({
      envelope: envelope({ inputHash: 'b' }),
      taskId: 't',
      sessionId: 's-2',
      engineId: 'rule-comprehender',
      engineType: 'rule',
      verdictPass: true,
    });
    const s1 = store.mostRecentForSession('s-1', 10);
    expect(s1).toHaveLength(1);
    expect(s1[0]!.input_hash).toBe('a');
  });

  test('markOutcome updates a pending record', () => {
    store.record({
      envelope: envelope({ inputHash: 'x' }),
      taskId: 't',
      sessionId: 's',
      engineId: 'rule-comprehender',
      engineType: 'rule',
      verdictPass: true,
    });
    const ok = store.markOutcome('x', {
      outcome: 'confirmed',
      evidence: { reason: 'user continued' },
    });
    expect(ok).toBe(true);

    const rows = store.mostRecentForSession('s', 1);
    expect(rows[0]!.outcome).toBe('confirmed');
    expect(rows[0]!.outcome_evidence).toContain('user continued');
    expect(typeof rows[0]!.outcome_at).toBe('number');
  });

  test('markOutcome is idempotent: second call on same hash returns false', () => {
    store.record({
      envelope: envelope({ inputHash: 'once' }),
      taskId: 't',
      sessionId: 's',
      engineId: 'rule-comprehender',
      engineType: 'rule',
      verdictPass: true,
    });
    const first = store.markOutcome('once', { outcome: 'confirmed', evidence: {} });
    const second = store.markOutcome('once', { outcome: 'corrected', evidence: {} });
    expect(first).toBe(true);
    expect(second).toBe(false);
    // Original outcome preserved.
    const rows = store.mostRecentForSession('s', 1);
    expect(rows[0]!.outcome).toBe('confirmed');
  });

  test('markOutcome on missing hash returns false (no throw)', () => {
    const ok = store.markOutcome('nonexistent', { outcome: 'confirmed', evidence: {} });
    expect(ok).toBe(false);
  });

  test('recentByEngine returns only records with an outcome', () => {
    // One pending (outcome NULL), one with outcome.
    store.record({
      envelope: envelope({ inputHash: 'pending' }),
      taskId: 't',
      sessionId: 's',
      engineId: 'rule-comprehender',
      engineType: 'rule',
      verdictPass: true,
    });
    store.record({
      envelope: envelope({ inputHash: 'done' }),
      taskId: 't',
      sessionId: 's',
      engineId: 'rule-comprehender',
      engineType: 'rule',
      verdictPass: true,
    });
    store.markOutcome('done', { outcome: 'confirmed', evidence: {} });

    const engineRows = store.recentByEngine('rule-comprehender', 10);
    expect(engineRows).toHaveLength(1);
    expect(engineRows[0]!.input_hash).toBe('done');
  });

  test('recentByEngine scopes by engineId', () => {
    store.record({
      envelope: envelope({ inputHash: 'rule1' }),
      taskId: 't',
      sessionId: 's',
      engineId: 'rule-comprehender',
      engineType: 'rule',
      verdictPass: true,
    });
    store.markOutcome('rule1', { outcome: 'confirmed', evidence: {} });
    store.record({
      envelope: envelope({ inputHash: 'llm1' }),
      taskId: 't',
      sessionId: 's',
      engineId: 'llm-comprehender',
      engineType: 'llm',
      verdictPass: true,
    });
    store.markOutcome('llm1', { outcome: 'corrected', evidence: {} });

    expect(store.recentByEngine('rule-comprehender').map((r) => r.input_hash)).toEqual(['rule1']);
    expect(store.recentByEngine('llm-comprehender').map((r) => r.input_hash)).toEqual(['llm1']);
  });

  test('sweepStale marks old pending records as abandoned', () => {
    const now = 10_000;
    store.record({
      envelope: envelope({ inputHash: 'young' }),
      taskId: 't',
      sessionId: 's',
      engineId: 'rule-comprehender',
      engineType: 'rule',
      verdictPass: true,
      createdAt: now - 1_000, // recent
    });
    store.record({
      envelope: envelope({ inputHash: 'old' }),
      taskId: 't',
      sessionId: 's',
      engineId: 'rule-comprehender',
      engineType: 'rule',
      verdictPass: true,
      createdAt: now - 60_000, // 60s ago
    });

    const touched = store.sweepStale(30_000, { reason: 'test sweep' }, now);
    expect(touched).toBe(1); // only `old` qualifies
    const rows = store.mostRecentForSession('s', 10);
    const byHash = Object.fromEntries(rows.map((r) => [r.input_hash, r]));
    expect(byHash.old?.outcome).toBe('abandoned');
    expect(byHash.young?.outcome).toBeNull();
  });

  test('sweepStale ignores records that already have an outcome', () => {
    const now = 10_000;
    store.record({
      envelope: envelope({ inputHash: 'done-old' }),
      taskId: 't',
      sessionId: 's',
      engineId: 'rule-comprehender',
      engineType: 'rule',
      verdictPass: true,
      createdAt: now - 60_000,
    });
    store.markOutcome('done-old', { outcome: 'confirmed', evidence: {} });

    const touched = store.sweepStale(30_000, { reason: 'test' }, now);
    expect(touched).toBe(0);
  });

  // ── AXM#4: engine_type column ───────────────────────────────────────

  test('record persists engine_type and it round-trips via mostRecentForSession', () => {
    store.record({
      envelope: envelope({ inputHash: 'r1' }),
      taskId: 't',
      sessionId: 's',
      engineId: 'rule-comprehender',
      engineType: 'rule',
      verdictPass: true,
    });
    store.record({
      envelope: envelope({ inputHash: 'l1' }),
      taskId: 't',
      sessionId: 's',
      engineId: 'llm-comprehender',
      engineType: 'llm',
      verdictPass: true,
    });
    const rows = store.mostRecentForSession('s', 10);
    const byHash = Object.fromEntries(rows.map((r) => [r.input_hash, r]));
    expect(byHash.r1!.engine_type).toBe('rule');
    expect(byHash.l1!.engine_type).toBe('llm');
  });

  // ── BUG#1 regression: composite PK (input_hash, engine_id) ────────
  // Before migration 037, PK was input_hash alone, so stage-1 and
  // stage-2 engines sharing the same hash silently dropped stage 2.
  test('same inputHash with different engineId BOTH persist (stage 1 + stage 2)', () => {
    const env = envelope({ inputHash: 'hybrid-turn' });
    const stage1 = store.record({
      envelope: env,
      taskId: 't',
      sessionId: 's',
      engineId: 'rule-comprehender',
      engineType: 'rule',
      verdictPass: true,
    });
    const stage2 = store.record({
      envelope: env,
      taskId: 't',
      sessionId: 's',
      engineId: 'llm-comprehender',
      engineType: 'llm',
      verdictPass: true,
    });
    expect(stage1).toBe(true);
    expect(stage2).toBe(true);
    expect(store.count()).toBe(2);

    // markOutcome by hash updates BOTH rows — outcome is a property of
    // the user's turn, not an engine. Calibration for each engine then
    // reads its own row via recentByEngine.
    store.markOutcome('hybrid-turn', { outcome: 'confirmed', evidence: {} });
    expect(store.recentByEngine('rule-comprehender', 10, 'rule')).toHaveLength(1);
    expect(store.recentByEngine('llm-comprehender', 10, 'llm')).toHaveLength(1);
  });

  test('envelope_json round-trips back to a parseable message', () => {
    const original = envelope({
      inputHash: 'round-trip',
      rootGoal: 'write poem',
    });
    store.record({
      envelope: original,
      taskId: 't',
      sessionId: 's',
      engineId: 'rule-comprehender',
      engineType: 'rule',
      verdictPass: true,
    });
    const rows = store.mostRecentForSession('s', 1);
    const parsed = JSON.parse(rows[0]!.envelope_json) as ComprehendedTaskMessage;
    expect(parsed.params.inputHash).toBe('round-trip');
    expect(parsed.params.rootGoal).toBe('write poem');
  });
});
