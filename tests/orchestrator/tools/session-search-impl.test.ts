/**
 * session-search-impl — behavior tests for the pure search function.
 *
 * Each test drives real SQLite + the migration-003 FTS5 schema to exercise
 * the actual query plan, mirroring how `DefaultMemoryProvider` is covered.
 */
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, it } from 'bun:test';
import type { ConfidenceTier } from '../../../src/core/confidence-tier.ts';
import { migration001 } from '../../../src/db/migrations/001_initial_schema.ts';
import { MigrationRunner } from '../../../src/db/migrations/migration-runner.ts';
import { DefaultMemoryProvider } from '../../../src/memory/provider/default-provider.ts';
import type { MemoryKind, MemoryRecord } from '../../../src/memory/provider/types.ts';
import { searchSessions } from '../../../src/orchestrator/tools/session-search-impl.ts';

// ── Fixtures ────────────────────────────────────────────────────────────

const NOW = 1_700_000_000_000;

function freshDb(): Database {
  const db = new Database(':memory:');
  const runner = new MigrationRunner();
  runner.migrate(db, [migration001]);
  return db;
}

function baseInput(overrides: Partial<Omit<MemoryRecord, 'id'>> = {}): Omit<MemoryRecord, 'id'> {
  return {
    profile: 'default',
    kind: 'fact' as MemoryKind,
    content: 'Bun uses bun:sqlite natively',
    confidence: 0.7,
    evidenceTier: 'heuristic' as ConfidenceTier,
    evidenceChain: [{ kind: 'turn', hash: 'a'.repeat(64), turnId: 't1' }],
    temporalContext: { createdAt: NOW },
    ...overrides,
  };
}

function writeWithProvider(db: Database, input: Omit<MemoryRecord, 'id'>, clock: () => number = () => NOW) {
  const provider = new DefaultMemoryProvider({ db, clock });
  return provider.write(input);
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('searchSessions — basic paths', () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  it('returns empty result on an empty DB', async () => {
    const result = await searchSessions(
      { query: 'anything', profile: 'default' },
      { db, clock: () => NOW },
    );
    expect(result.hits.length).toBe(0);
    expect(result.totalCandidates).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('finds a single matching record', async () => {
    await writeWithProvider(db, baseInput({ content: 'Bun is a fast JS runtime' }));
    const result = await searchSessions(
      { query: 'Bun', profile: 'default' },
      { db, clock: () => NOW },
    );
    expect(result.hits.length).toBe(1);
    expect(result.hits[0]?.content).toContain('Bun');
    expect(result.hits[0]?.evidenceTier).toBe('heuristic');
  });
});

describe('searchSessions — profile scoping (§3)', () => {
  it('excludes records written under a different profile', async () => {
    const db = freshDb();
    await writeWithProvider(db, baseInput({ profile: 'alpha', content: 'alpha fruit cake' }));
    await writeWithProvider(db, baseInput({ profile: 'beta', content: 'beta fruit cake' }));

    const result = await searchSessions(
      { query: 'fruit', profile: 'beta' },
      { db, clock: () => NOW },
    );
    expect(result.hits.length).toBe(1);
    expect(result.hits[0]?.content).toContain('beta');
  });

  it('rejects cross-profile wildcard "*" with a warning', async () => {
    const db = freshDb();
    await writeWithProvider(db, baseInput({ content: 'hello' }));
    const result = await searchSessions(
      { query: 'hello', profile: '*' },
      { db, clock: () => NOW },
    );
    expect(result.totalCandidates).toBe(0);
    expect(result.warning).toBe('cross_profile_not_allowed');
  });

  it('rejects cross-profile wildcard "ALL"', async () => {
    const db = freshDb();
    const result = await searchSessions(
      { query: 'hello', profile: 'ALL' },
      { db, clock: () => NOW },
    );
    expect(result.warning).toBe('cross_profile_not_allowed');
  });
});

describe('searchSessions — kind filter', () => {
  it('restricts hits to provided kinds', async () => {
    const db = freshDb();
    await writeWithProvider(db, baseInput({ kind: 'fact', content: 'keyword alpha' }));
    await writeWithProvider(
      db,
      baseInput({
        kind: 'preference',
        content: 'keyword beta',
        temporalContext: { createdAt: NOW + 1 },
      }),
    );

    const result = await searchSessions(
      { query: 'keyword', profile: 'default', kinds: ['preference'] },
      { db, clock: () => NOW + 10 },
    );
    expect(result.hits.length).toBe(1);
    expect(result.hits[0]?.kind).toBe('preference');
  });
});

describe('searchSessions — minTier', () => {
  it('filters out weaker-than-minimum tiers', async () => {
    const db = freshDb();
    await writeWithProvider(
      db,
      baseInput({ content: 'shared keyword heuristic', evidenceTier: 'heuristic', confidence: 0.7 }),
    );
    await writeWithProvider(
      db,
      baseInput({
        content: 'shared keyword probabilistic',
        evidenceTier: 'probabilistic',
        confidence: 0.5,
        temporalContext: { createdAt: NOW + 1 },
      }),
    );
    await writeWithProvider(
      db,
      baseInput({
        content: 'shared keyword speculative',
        evidenceTier: 'speculative',
        confidence: 0.3,
        temporalContext: { createdAt: NOW + 2 },
      }),
    );

    const result = await searchSessions(
      { query: 'shared', profile: 'default', minTier: 'heuristic' },
      { db, clock: () => NOW + 10 },
    );
    expect(result.hits.length).toBe(1);
    expect(result.hits[0]?.evidenceTier).toBe('heuristic');
  });
});

describe('searchSessions — freshness', () => {
  it('excludes records older than now - freshnessMs', async () => {
    const db = freshDb();
    // Old record.
    await writeWithProvider(
      db,
      baseInput({ content: 'recency keyword old', temporalContext: { createdAt: NOW - 10_000 } }),
    );
    // Fresh record.
    await writeWithProvider(
      db,
      baseInput({ content: 'recency keyword new', temporalContext: { createdAt: NOW - 100 } }),
    );

    const result = await searchSessions(
      { query: 'recency', profile: 'default', freshnessMs: 1_000 },
      { db, clock: () => NOW },
    );
    expect(result.hits.length).toBe(1);
    expect(result.hits[0]?.content).toContain('new');
  });
});

describe('searchSessions — limit bounds', () => {
  it('clamps limit to [1, 50] and reports truncated', async () => {
    const db = freshDb();
    // Insert 3 matching records.
    for (let i = 0; i < 3; i++) {
      await writeWithProvider(
        db,
        baseInput({ content: `bounded keyword item-${i}`, temporalContext: { createdAt: NOW + i } }),
      );
    }
    // limit=0 should clamp to 1.
    const r0 = await searchSessions(
      { query: 'bounded', profile: 'default', limit: 0 },
      { db, clock: () => NOW + 100 },
    );
    expect(r0.hits.length).toBe(1);
    expect(r0.truncated).toBe(true);
    expect(r0.totalCandidates).toBe(3);

    // limit=999 should clamp to 50 (we only have 3 so truncated=false).
    const rBig = await searchSessions(
      { query: 'bounded', profile: 'default', limit: 999 },
      { db, clock: () => NOW + 100 },
    );
    expect(rBig.hits.length).toBe(3);
    expect(rBig.truncated).toBe(false);
  });
});

describe('searchSessions — sessionScope', () => {
  it("errors when sessionScope='current' has no sessionId", async () => {
    const db = freshDb();
    const result = await searchSessions(
      { query: 'x', profile: 'default', sessionScope: 'current' },
      { db, clock: () => NOW },
    );
    expect(result.hits.length).toBe(0);
    expect(result.warning).toBe('session_scope_requires_sessionId');
  });

  it("current scope filters to the provided sessionId", async () => {
    const db = freshDb();
    await writeWithProvider(db, baseInput({ content: 'scoped hit a', sessionId: 'sess_1' }));
    await writeWithProvider(
      db,
      baseInput({
        content: 'scoped hit b',
        sessionId: 'sess_2',
        temporalContext: { createdAt: NOW + 1 },
      }),
    );

    const result = await searchSessions(
      { query: 'scoped', profile: 'default', sessionScope: 'current', sessionId: 'sess_1' },
      { db, clock: () => NOW + 10 },
    );
    expect(result.hits.length).toBe(1);
    expect(result.hits[0]?.sessionId).toBe('sess_1');
  });
});

describe('searchSessions — ranking (A5)', () => {
  it('deterministic outranks probabilistic at equal similarity', async () => {
    const db = freshDb();
    const sharedCreatedAt = NOW - 1_000;
    await writeWithProvider(
      db,
      baseInput({
        content: 'ranker keyword target',
        evidenceTier: 'deterministic',
        confidence: 1.0,
        contentHash: 'c'.repeat(64),
        temporalContext: { createdAt: sharedCreatedAt },
      }),
    );
    await writeWithProvider(
      db,
      baseInput({
        content: 'ranker keyword target',
        evidenceTier: 'probabilistic',
        confidence: 0.5,
        temporalContext: { createdAt: sharedCreatedAt + 1 },
      }),
    );

    const result = await searchSessions(
      { query: 'ranker', profile: 'default' },
      { db, clock: () => NOW },
    );
    expect(result.hits.length).toBe(2);
    expect(result.hits[0]?.evidenceTier).toBe('deterministic');
    expect(result.hits[1]?.evidenceTier).toBe('probabilistic');
  });
});

describe('searchSessions — error resilience', () => {
  it('malformed FTS5 query does not throw — returns empty with warning', async () => {
    const db = freshDb();
    await writeWithProvider(db, baseInput({ content: 'some content' }));
    // A truly broken FTS5 expression survives the phrase-wrap (since we
    // literal-quote it), so in practice this test also verifies the quoting
    // protects against operator injection. The function should still succeed.
    const result = await searchSessions(
      { query: 'AND OR NEAR:', profile: 'default' },
      { db, clock: () => NOW },
    );
    // Either zero hits (no literal match) OR surfaces as fts5_query_error —
    // both branches are acceptable "does not throw" behaviors.
    expect(Array.isArray(result.hits)).toBe(true);
    expect(result.hits.length).toBe(0);
  });

  it('empty query returns empty with warning', async () => {
    const db = freshDb();
    const result = await searchSessions(
      { query: '   ', profile: 'default' },
      { db, clock: () => NOW },
    );
    expect(result.totalCandidates).toBe(0);
    expect(result.warning).toBe('empty_query');
  });
});
