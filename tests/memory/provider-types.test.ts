/**
 * MemoryProvider types + migration 003 — behavior tests.
 *
 * Covers:
 *   - Zod schema acceptance / rejection across tier × kind combos.
 *   - Profile regex enforcement (no wildcard, no uppercase).
 *   - Deterministic-tier requires contentHash (A4).
 *   - Confidence clamp per TIER_CONFIDENCE_CEILING (A5).
 *   - Migration 003 applies cleanly on a fresh in-memory DB.
 *   - FTS5 sync triggers mirror insert/update/delete on memory_records.
 */

import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import type { ConfidenceTier } from '../../src/core/confidence-tier.ts';
import { migration003 } from '../../src/db/migrations/003_memory_records.ts';
import { MigrationRunner } from '../../src/db/migrations/migration-runner.ts';
import { MemoryRecordInputSchema, MemoryRecordSchema, SearchOptsSchema } from '../../src/memory/provider/types.ts';

// ── Zod schema tests ───────────────────────────────────────────────────

const baseRecord = {
  id: 'mem_01',
  profile: 'default',
  kind: 'fact' as const,
  content: 'Bun uses bun:sqlite natively.',
  confidence: 0.9,
  evidenceTier: 'heuristic' as ConfidenceTier,
  evidenceChain: [{ kind: 'turn', hash: 'a'.repeat(64), turnId: 't1' }],
  temporalContext: { createdAt: 1_700_000_000_000 },
};

describe('MemoryRecordSchema — valid shapes', () => {
  it('accepts a heuristic fact with full evidence chain', () => {
    const parsed = MemoryRecordSchema.parse(baseRecord);
    expect(parsed.id).toBe('mem_01');
    expect(parsed.evidenceTier).toBe('heuristic');
  });

  it('accepts a deterministic record when contentHash is present', () => {
    const parsed = MemoryRecordSchema.parse({
      ...baseRecord,
      evidenceTier: 'deterministic',
      confidence: 1.0,
      contentHash: 'b'.repeat(64),
    });
    expect(parsed.contentHash).toBe('b'.repeat(64));
  });

  it('accepts a probabilistic episodic record with session scope', () => {
    const parsed = MemoryRecordSchema.parse({
      ...baseRecord,
      kind: 'episodic',
      evidenceTier: 'probabilistic',
      confidence: 0.6,
      sessionId: 'sess_42',
    });
    expect(parsed.kind).toBe('episodic');
    expect(parsed.sessionId).toBe('sess_42');
  });

  it('accepts a speculative user-section with metadata', () => {
    const parsed = MemoryRecordSchema.parse({
      ...baseRecord,
      kind: 'user-section',
      evidenceTier: 'speculative',
      confidence: 0.3,
      metadata: { section: 'preferences', draft: true },
    });
    expect(parsed.metadata?.section).toBe('preferences');
  });

  it('accepts profiles matching the kebab identifier regex', () => {
    const parsed = MemoryRecordSchema.parse({ ...baseRecord, profile: 'work-alpha' });
    expect(parsed.profile).toBe('work-alpha');
  });
});

describe('MemoryRecordSchema — rejections', () => {
  it('rejects records missing the profile field', () => {
    const { profile: _drop, ...rest } = baseRecord;
    expect(() => MemoryRecordSchema.parse(rest)).toThrow();
  });

  it('rejects profiles that start with a digit or contain uppercase', () => {
    expect(() => MemoryRecordSchema.parse({ ...baseRecord, profile: '1bad' })).toThrow();
    expect(() => MemoryRecordSchema.parse({ ...baseRecord, profile: 'Mixed' })).toThrow();
  });

  it('rejects an unknown evidenceTier string', () => {
    expect(() =>
      MemoryRecordSchema.parse({
        ...baseRecord,
        evidenceTier: 'guessed' as unknown as ConfidenceTier,
      }),
    ).toThrow();
  });

  it('rejects a deterministic record without contentHash', () => {
    expect(() =>
      MemoryRecordSchema.parse({
        ...baseRecord,
        evidenceTier: 'deterministic',
        confidence: 1.0,
      }),
    ).toThrow(/contentHash/);
  });

  it('rejects confidence above the tier ceiling (probabilistic > 0.85)', () => {
    expect(() =>
      MemoryRecordSchema.parse({
        ...baseRecord,
        evidenceTier: 'probabilistic',
        confidence: 0.9,
      }),
    ).toThrow(/TIER_CONFIDENCE_CEILING/);
  });

  it('rejects confidence above the tier ceiling (speculative > 0.6)', () => {
    expect(() =>
      MemoryRecordSchema.parse({
        ...baseRecord,
        evidenceTier: 'speculative',
        confidence: 0.8,
      }),
    ).toThrow();
  });

  it('rejects an unknown kind', () => {
    expect(() => MemoryRecordSchema.parse({ ...baseRecord, kind: 'rumor' as unknown as 'fact' })).toThrow();
  });
});

describe('MemoryRecordInputSchema — write-side (no id yet)', () => {
  it('accepts a valid record input without id', () => {
    const { id: _omit, ...input } = baseRecord;
    const parsed = MemoryRecordInputSchema.parse(input);
    expect(parsed.content).toBe(baseRecord.content);
  });

  it('still enforces deterministic-requires-contentHash on input', () => {
    const { id: _omit, ...input } = baseRecord;
    expect(() =>
      MemoryRecordInputSchema.parse({
        ...input,
        evidenceTier: 'deterministic',
        confidence: 1.0,
      }),
    ).toThrow();
  });
});

describe('SearchOptsSchema', () => {
  it('accepts a minimal opts with just profile', () => {
    const parsed = SearchOptsSchema.parse({ profile: 'default' });
    expect(parsed.profile).toBe('default');
  });

  it('accepts full opts with limit, kinds, minTier, freshnessMs', () => {
    const parsed = SearchOptsSchema.parse({
      profile: 'work-alpha',
      limit: 20,
      kinds: ['fact', 'preference'],
      minTier: 'heuristic',
      freshnessMs: 60_000,
    });
    expect(parsed.limit).toBe(20);
    expect(parsed.minTier).toBe('heuristic');
  });

  it('rejects cross-profile wildcards (no "*" or "ALL" here)', () => {
    expect(() => SearchOptsSchema.parse({ profile: '*' })).toThrow();
    expect(() => SearchOptsSchema.parse({ profile: 'ALL' })).toThrow();
  });

  it('rejects missing profile', () => {
    expect(() => SearchOptsSchema.parse({ limit: 5 })).toThrow();
  });

  it('rejects non-positive limit', () => {
    expect(() => SearchOptsSchema.parse({ profile: 'default', limit: 0 })).toThrow();
    expect(() => SearchOptsSchema.parse({ profile: 'default', limit: -3 })).toThrow();
  });
});

// ── Migration + FTS5 behavior ──────────────────────────────────────────

function freshDb(): Database {
  const db = new Database(':memory:');
  const runner = new MigrationRunner();
  const result = runner.migrate(db, [migration003]);
  expect(result.applied).toEqual([3]);
  return db;
}

describe('migration003 — schema', () => {
  it('applies cleanly on a fresh in-memory database', () => {
    const db = freshDb();
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{
      name: string;
    }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('memory_records');
    expect(names).toContain('memory_records_fts');
    db.close();
  });

  it('is idempotent — second run applies nothing', () => {
    const db = new Database(':memory:');
    const runner = new MigrationRunner();
    runner.migrate(db, [migration003]);
    const second = runner.migrate(db, [migration003]);
    expect(second.applied).toEqual([]);
    expect(second.current).toBe(3);
    db.close();
  });

  it('enforces kind CHECK constraint', () => {
    const db = freshDb();
    expect(() =>
      db.run(
        `INSERT INTO memory_records
           (id, profile, kind, content, confidence, evidence_tier, evidence_chain, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        ['x', 'default', 'gossip', 'hi', 0.5, 'heuristic', '[]', Date.now()],
      ),
    ).toThrow();
    db.close();
  });

  it('enforces evidence_tier CHECK constraint', () => {
    const db = freshDb();
    expect(() =>
      db.run(
        `INSERT INTO memory_records
           (id, profile, kind, content, confidence, evidence_tier, evidence_chain, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        ['x', 'default', 'fact', 'hi', 0.5, 'guess', '[]', Date.now()],
      ),
    ).toThrow();
    db.close();
  });

  it('defaults profile to "default" when omitted', () => {
    const db = freshDb();
    db.run(
      `INSERT INTO memory_records
         (id, kind, content, confidence, evidence_tier, evidence_chain, created_at)
       VALUES (?,?,?,?,?,?,?)`,
      ['r1', 'fact', 'hello', 0.5, 'heuristic', '[]', Date.now()],
    );
    const row = db.query('SELECT profile FROM memory_records WHERE id = ?').get('r1') as {
      profile: string;
    };
    expect(row.profile).toBe('default');
    db.close();
  });
});

describe('migration003 — FTS5 trigger sync', () => {
  it('inserts a matching FTS5 row on base insert', () => {
    const db = freshDb();
    db.run(
      `INSERT INTO memory_records
         (id, profile, kind, content, confidence, evidence_tier, evidence_chain, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      ['r1', 'default', 'fact', 'alpha beta gamma', 0.5, 'heuristic', '[]', Date.now()],
    );
    const fts = db.query('SELECT id, content FROM memory_records_fts WHERE id = ?').get('r1') as
      | { id: string; content: string }
      | undefined;
    expect(fts?.id).toBe('r1');
    expect(fts?.content).toBe('alpha beta gamma');
    db.close();
  });

  it('removes the FTS5 row on base delete', () => {
    const db = freshDb();
    db.run(
      `INSERT INTO memory_records
         (id, profile, kind, content, confidence, evidence_tier, evidence_chain, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      ['r1', 'default', 'fact', 'alpha', 0.5, 'heuristic', '[]', Date.now()],
    );
    db.run('DELETE FROM memory_records WHERE id = ?', ['r1']);
    const fts = db.query('SELECT id FROM memory_records_fts WHERE id = ?').get('r1');
    expect(fts).toBeNull();
    db.close();
  });

  it('syncs content on base update', () => {
    const db = freshDb();
    db.run(
      `INSERT INTO memory_records
         (id, profile, kind, content, confidence, evidence_tier, evidence_chain, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      ['r1', 'default', 'fact', 'alpha', 0.5, 'heuristic', '[]', Date.now()],
    );
    db.run('UPDATE memory_records SET content = ? WHERE id = ?', ['omega delta', 'r1']);
    const fts = db.query('SELECT content FROM memory_records_fts WHERE id = ?').get('r1') as { content: string };
    expect(fts.content).toBe('omega delta');
    db.close();
  });

  it('FTS5 MATCH over content returns the correct row scoped by profile', () => {
    const db = freshDb();
    db.run(
      `INSERT INTO memory_records
         (id, profile, kind, content, confidence, evidence_tier, evidence_chain, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      ['r1', 'work', 'fact', 'bun runtime is fast', 0.7, 'heuristic', '[]', Date.now()],
    );
    db.run(
      `INSERT INTO memory_records
         (id, profile, kind, content, confidence, evidence_tier, evidence_chain, created_at)
       VALUES (?,?,?,?,?,?,?,?)`,
      ['r2', 'play', 'fact', 'bun runtime is fast', 0.7, 'heuristic', '[]', Date.now()],
    );

    const hits = db
      .query(
        `SELECT id FROM memory_records_fts
         WHERE memory_records_fts MATCH ? AND profile = ?`,
      )
      .all('bun runtime', 'work') as Array<{ id: string }>;
    expect(hits.map((h) => h.id)).toEqual(['r1']);
    db.close();
  });
});
