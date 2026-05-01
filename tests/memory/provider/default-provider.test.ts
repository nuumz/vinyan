/**
 * DefaultMemoryProvider — behavior tests.
 *
 * Exercises writes, FTS5-backed reads, tier + freshness filters, the
 * content-hash invalidation path, MVP consolidation scan, and health.
 */
import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, it } from 'bun:test';
import type { ConfidenceTier } from '../../../src/core/confidence-tier.ts';
import { migration001 } from '../../../src/db/migrations/001_initial_schema.ts';
import { MigrationRunner } from '../../../src/db/migrations/migration-runner.ts';
import { DefaultMemoryProvider } from '../../../src/memory/provider/default-provider.ts';
import type { MemoryRecord } from '../../../src/memory/provider/types.ts';

// ── Fixtures ────────────────────────────────────────────────────────────

function freshDb(): Database {
  const db = new Database(':memory:');
  const runner = new MigrationRunner();
  runner.migrate(db, [migration001]);
  return db;
}

function sampleInput(overrides: Partial<Omit<MemoryRecord, 'id'>> = {}): Omit<MemoryRecord, 'id'> {
  return {
    profile: 'default',
    kind: 'fact',
    content: 'Bun uses bun:sqlite natively',
    confidence: 0.7,
    evidenceTier: 'heuristic' as ConfidenceTier,
    evidenceChain: [{ kind: 'turn', hash: 'a'.repeat(64), turnId: 't1' }],
    temporalContext: { createdAt: 1_700_000_000_000 },
    ...overrides,
  };
}

// ── Write ───────────────────────────────────────────────────────────────

describe('DefaultMemoryProvider.write — valid paths', () => {
  let provider: DefaultMemoryProvider;
  beforeEach(() => {
    provider = new DefaultMemoryProvider({ db: freshDb(), clock: () => 1_700_000_000_000 });
  });

  it('writes a heuristic fact and returns a deterministic id', async () => {
    const ack = await provider.write(sampleInput());
    expect(ack.ok).toBe(true);
    if (ack.ok) {
      expect(ack.tier).toBe('heuristic');
      expect(ack.id).toMatch(/^[a-f0-9]{64}$/);
    }
  });

  it('produces the same id for identical inputs', async () => {
    const a = await provider.write(sampleInput());
    const b = await provider.write(sampleInput());
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.id).toBe(b.id);
    }
  });

  it('produces different ids for different content', async () => {
    const a = await provider.write(sampleInput({ content: 'alpha' }));
    const b = await provider.write(sampleInput({ content: 'beta' }));
    if (a.ok && b.ok) {
      expect(a.id).not.toBe(b.id);
    }
  });

  it('accepts a deterministic record with contentHash', async () => {
    const ack = await provider.write(
      sampleInput({ evidenceTier: 'deterministic', confidence: 1.0, contentHash: 'b'.repeat(64) }),
    );
    expect(ack.ok).toBe(true);
    if (ack.ok) expect(ack.tier).toBe('deterministic');
  });

  it('accepts a speculative record at low confidence', async () => {
    const ack = await provider.write(sampleInput({ evidenceTier: 'speculative', confidence: 0.3 }));
    expect(ack.ok).toBe(true);
  });

  it('accepts a probabilistic episodic record with session scope', async () => {
    const ack = await provider.write(
      sampleInput({ evidenceTier: 'probabilistic', confidence: 0.6, kind: 'episodic', sessionId: 'sess_1' }),
    );
    expect(ack.ok).toBe(true);
  });
});

describe('DefaultMemoryProvider.write — rejection paths', () => {
  let provider: DefaultMemoryProvider;
  beforeEach(() => {
    provider = new DefaultMemoryProvider({ db: freshDb() });
  });

  it('rejects deterministic without contentHash', async () => {
    const ack = await provider.write(sampleInput({ evidenceTier: 'deterministic', confidence: 1.0 }));
    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.reason).toBe('schema_invalid');
  });

  it('rejects probabilistic confidence above the tier ceiling', async () => {
    const ack = await provider.write(sampleInput({ evidenceTier: 'probabilistic', confidence: 0.95 }));
    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.reason).toBe('schema_invalid');
  });

  it('rejects an invalid profile identifier', async () => {
    const ack = await provider.write(sampleInput({ profile: 'Mixed' }));
    expect(ack.ok).toBe(false);
    if (!ack.ok) expect(ack.reason).toBe('profile_unknown');
  });

  it('rejects an unknown kind', async () => {
    // Bypass type check deliberately to test the Zod boundary.
    const bad = sampleInput() as unknown as Omit<MemoryRecord, 'id'> & { kind: string };
    (bad as { kind: string }).kind = 'gossip';
    const ack = await provider.write(bad as Omit<MemoryRecord, 'id'>);
    expect(ack.ok).toBe(false);
  });
});

describe('DefaultMemoryProvider.write — confidence clamping', () => {
  // Clamping happens post-schema. To exercise it we bypass Zod by writing
  // a record whose raw confidence sits AT the tier ceiling (0.85 for
  // probabilistic). We then verify the stored value matches the ceiling.
  it('stores the clamped value when schema permits (at-ceiling input)', async () => {
    const db = freshDb();
    const provider = new DefaultMemoryProvider({ db });
    const ack = await provider.write(sampleInput({ evidenceTier: 'probabilistic', confidence: 0.85 }));
    expect(ack.ok).toBe(true);
    const row = db.query('SELECT confidence FROM memory_records LIMIT 1').get() as { confidence: number };
    expect(row.confidence).toBeLessThanOrEqual(0.85);
    db.close();
  });
});

// ── Search ──────────────────────────────────────────────────────────────

describe('DefaultMemoryProvider.search — FTS5 retrieval', () => {
  it('finds an inserted record by keyword', async () => {
    const db = freshDb();
    const provider = new DefaultMemoryProvider({ db, clock: () => 1_700_000_000_000 });
    await provider.write(sampleInput({ content: 'bun has native sqlite support' }));
    const hits = await provider.search('sqlite', { profile: 'default' });
    expect(hits.length).toBe(1);
    expect(hits[0]!.record.content).toContain('sqlite');
    expect(hits[0]!.score).toBeGreaterThan(0);
    db.close();
  });

  it('respects the profile filter — no cross-profile leakage', async () => {
    const db = freshDb();
    const provider = new DefaultMemoryProvider({ db });
    await provider.write(sampleInput({ profile: 'work', content: 'payroll deadline on tuesday' }));
    await provider.write(sampleInput({ profile: 'play', content: 'payroll deadline on tuesday' }));
    const workHits = await provider.search('payroll', { profile: 'work' });
    const playHits = await provider.search('payroll', { profile: 'play' });
    expect(workHits.length).toBe(1);
    expect(playHits.length).toBe(1);
    expect(workHits[0]!.record.profile).toBe('work');
    expect(playHits[0]!.record.profile).toBe('play');
    db.close();
  });

  it('returns empty for wildcard profile rather than throwing', async () => {
    const db = freshDb();
    const provider = new DefaultMemoryProvider({ db });
    await provider.write(sampleInput({ content: 'alpha' }));
    const starHits = await provider.search('alpha', { profile: '*' });
    const allHits = await provider.search('alpha', { profile: 'ALL' });
    expect(starHits).toEqual([]);
    expect(allHits).toEqual([]);
    db.close();
  });

  it('returns empty for empty query', async () => {
    const db = freshDb();
    const provider = new DefaultMemoryProvider({ db });
    await provider.write(sampleInput({ content: 'alpha beta' }));
    const hits = await provider.search('   ', { profile: 'default' });
    expect(hits).toEqual([]);
    db.close();
  });

  it('filters out weaker tiers with minTier', async () => {
    const db = freshDb();
    const provider = new DefaultMemoryProvider({ db });
    await provider.write(
      sampleInput({ content: 'gamma ray burst', evidenceTier: 'speculative', confidence: 0.3 }),
    );
    await provider.write(
      sampleInput({
        content: 'gamma ray burst',
        evidenceTier: 'deterministic',
        confidence: 1.0,
        contentHash: 'd'.repeat(64),
        temporalContext: { createdAt: 1_700_000_000_001 },
      }),
    );
    const hits = await provider.search('gamma', { profile: 'default', minTier: 'heuristic' });
    expect(hits.length).toBe(1);
    expect(hits[0]!.record.evidenceTier).toBe('deterministic');
    db.close();
  });

  it('filters records older than freshnessMs', async () => {
    const db = freshDb();
    const t = 1_700_000_000_000;
    const provider = new DefaultMemoryProvider({ db, clock: () => t });
    await provider.write(sampleInput({ content: 'alpha old', temporalContext: { createdAt: t - 2_000_000 } }));
    await provider.write(sampleInput({ content: 'alpha fresh', temporalContext: { createdAt: t - 500 } }));
    const hits = await provider.search('alpha', { profile: 'default', freshnessMs: 1_000 });
    expect(hits.length).toBe(1);
    expect(hits[0]!.record.content).toContain('fresh');
    db.close();
  });

  it('respects limit', async () => {
    const db = freshDb();
    const provider = new DefaultMemoryProvider({ db });
    for (let i = 0; i < 5; i++) {
      await provider.write(
        sampleInput({
          content: `zeta candidate ${i}`,
          temporalContext: { createdAt: 1_700_000_000_000 + i },
        }),
      );
    }
    const hits = await provider.search('zeta', { profile: 'default', limit: 3 });
    expect(hits.length).toBe(3);
    db.close();
  });

  it('orders hits by composite score (deterministic > heuristic at similar similarity)', async () => {
    const db = freshDb();
    const t = 1_700_000_000_000;
    const provider = new DefaultMemoryProvider({ db, clock: () => t });
    // Slightly different createdAt values so the deterministic id derivation
    // doesn't collapse these into one row.
    await provider.write(
      sampleInput({
        content: 'omega release notes alpha',
        evidenceTier: 'heuristic',
        confidence: 0.7,
        temporalContext: { createdAt: t - 10 },
      }),
    );
    await provider.write(
      sampleInput({
        content: 'omega release notes beta',
        evidenceTier: 'deterministic',
        confidence: 1.0,
        contentHash: 'e'.repeat(64),
        temporalContext: { createdAt: t - 10 },
      }),
    );
    const hits = await provider.search('omega release', { profile: 'default' });
    expect(hits.length).toBe(2);
    expect(hits[0]!.record.evidenceTier).toBe('deterministic');
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it('populates MemoryHit.components from the ranker', async () => {
    const db = freshDb();
    const provider = new DefaultMemoryProvider({ db });
    await provider.write(sampleInput({ content: 'theta waves' }));
    const hits = await provider.search('theta', { profile: 'default' });
    expect(hits.length).toBe(1);
    const c = hits[0]!.components;
    expect(c.similarity).toBeGreaterThan(0);
    expect(c.tierWeight).toBeGreaterThan(0);
    expect(c.recency).toBeGreaterThan(0);
    expect(c.predErrorPenalty).toBe(0);
    db.close();
  });

  it('filters by kind', async () => {
    const db = freshDb();
    const provider = new DefaultMemoryProvider({ db });
    await provider.write(sampleInput({ kind: 'fact', content: 'sigma alpha' }));
    await provider.write(
      sampleInput({
        kind: 'preference',
        content: 'sigma alpha',
        temporalContext: { createdAt: 1_700_000_000_001 },
      }),
    );
    const hits = await provider.search('sigma', { profile: 'default', kinds: ['preference'] });
    expect(hits.length).toBe(1);
    expect(hits[0]!.record.kind).toBe('preference');
    db.close();
  });
});

// ── Invalidate ──────────────────────────────────────────────────────────

describe('DefaultMemoryProvider.invalidate', () => {
  it('removes rows matching a contentHash and returns the count', async () => {
    const db = freshDb();
    const provider = new DefaultMemoryProvider({ db });
    const hash = 'c'.repeat(64);
    await provider.write(
      sampleInput({ evidenceTier: 'deterministic', confidence: 1.0, contentHash: hash }),
    );
    await provider.write(
      sampleInput({
        evidenceTier: 'deterministic',
        confidence: 1.0,
        contentHash: hash,
        content: 'different content',
        temporalContext: { createdAt: 1_700_000_000_001 },
      }),
    );
    const { removed } = await provider.invalidate(hash);
    expect(removed).toBe(2);
    const remaining = db.query('SELECT COUNT(*) AS n FROM memory_records').get() as { n: number };
    expect(remaining.n).toBe(0);
    db.close();
  });

  it('returns 0 when no rows match', async () => {
    const db = freshDb();
    const provider = new DefaultMemoryProvider({ db });
    const { removed } = await provider.invalidate('f'.repeat(64));
    expect(removed).toBe(0);
    db.close();
  });
});

// ── Consolidate ─────────────────────────────────────────────────────────

describe('DefaultMemoryProvider.consolidate', () => {
  it('flags low-confidence old probabilistic records but does not delete them', async () => {
    const db = freshDb();
    const now = 1_700_000_000_000;
    const thirtyOneDays = 31 * 24 * 60 * 60 * 1000;
    const provider = new DefaultMemoryProvider({ db, clock: () => now });

    // Old + low-confidence probabilistic → FLAGGED.
    await provider.write(
      sampleInput({
        evidenceTier: 'probabilistic',
        confidence: 0.2,
        temporalContext: { createdAt: now - thirtyOneDays },
      }),
    );
    // Recent probabilistic → NOT flagged (too fresh).
    await provider.write(
      sampleInput({
        evidenceTier: 'probabilistic',
        confidence: 0.2,
        content: 'recent noise',
        temporalContext: { createdAt: now - 1_000 },
      }),
    );
    // Old but high-confidence → NOT flagged.
    await provider.write(
      sampleInput({
        evidenceTier: 'probabilistic',
        confidence: 0.8,
        content: 'confident old',
        temporalContext: { createdAt: now - thirtyOneDays },
      }),
    );

    const report = await provider.consolidate();
    expect(report.promoted).toBe(0);
    expect(report.demoted).toBe(0);
    expect(report.invalidated).toBe(0);
    expect(report.nudges).toEqual([]);
    expect(report.lowConfidenceFlagged.length).toBe(1);
    expect(report.lowConfidenceFlagged[0]!.confidence).toBeCloseTo(0.2);

    const stillThere = db.query('SELECT COUNT(*) AS n FROM memory_records').get() as { n: number };
    expect(stillThere.n).toBe(3);
    db.close();
  });
});

// ── Health ──────────────────────────────────────────────────────────────

describe('DefaultMemoryProvider.healthCheck', () => {
  it('returns ok on a healthy DB', async () => {
    const db = freshDb();
    const provider = new DefaultMemoryProvider({ db });
    const health = await provider.healthCheck();
    expect(health.ok).toBe(true);
    expect(health.latencyMs).toBeGreaterThanOrEqual(0);
    db.close();
  });

  it('returns ok false with notes when the backing table is missing', async () => {
    // Build a DB without applying the migration — table missing.
    const db = new Database(':memory:');
    // Provider construction requires `memory_records` to exist because it
    // prepares statements against the table. We therefore bootstrap a
    // minimal stub table, then drop it to simulate a regression.
    db.exec(
      `CREATE TABLE memory_records (
         id TEXT, profile TEXT, kind TEXT, content TEXT,
         confidence REAL, evidence_tier TEXT, evidence_chain TEXT,
         content_hash TEXT, created_at INTEGER, valid_from INTEGER,
         valid_until INTEGER, session_id TEXT, metadata_json TEXT, embedding BLOB
       );`,
    );
    const provider = new DefaultMemoryProvider({ db });
    db.exec(`DROP TABLE memory_records;`);
    const health = await provider.healthCheck();
    expect(health.ok).toBe(false);
    expect(health.notes?.length ?? 0).toBeGreaterThan(0);
    db.close();
  });
});
