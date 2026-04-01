import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { runRetention } from '../../src/world-graph/retention.ts';
import { SCHEMA_SQL } from '../../src/world-graph/schema.ts';
import { WorldGraph } from '../../src/world-graph/world-graph.ts';

describe('World Graph Retention', () => {
  let wg: WorldGraph;

  beforeEach(() => {
    wg = new WorldGraph();
  });

  afterEach(() => {
    wg.close();
  });

  function storeFacts(count: number, options?: { sessionId?: string; age_ms?: number }) {
    const now = Date.now();
    for (let i = 0; i < count; i++) {
      wg.storeFact({
        target: `file-${i}.ts`,
        pattern: `pattern-${i}`,
        evidence: [{ file: `file-${i}.ts`, line: 1, snippet: `x${i}` }],
        oracleName: 'ast-oracle',
        fileHash: `hash-${i}`,
        sourceFile: `file-${i}.ts`,
        verifiedAt: now - (options?.age_ms ?? 0),
        sessionId: options?.sessionId,
        confidence: 1.0,
      });
    }
  }

  test('deletes facts older than maxAgeDays', () => {
    const DayMs = 24 * 60 * 60 * 1000;

    // Store old facts (40 days old) with distinct targets
    for (let i = 0; i < 5; i++) {
      wg.storeFact({
        target: `old-${i}.ts`,
        pattern: `old-pattern-${i}`,
        evidence: [{ file: `old-${i}.ts`, line: 1, snippet: `x${i}` }],
        oracleName: 'ast-oracle',
        fileHash: `old-hash-${i}`,
        sourceFile: `old-${i}.ts`,
        verifiedAt: Date.now() - 40 * DayMs,
        sessionId: 'old-session',
        confidence: 1.0,
      });
    }
    // Store recent facts
    storeFacts(3, { sessionId: 'new-session' });

    const db = (wg as any).db as Database;
    const before = db.query('SELECT COUNT(*) as cnt FROM facts').get() as { cnt: number };
    expect(before.cnt).toBe(8);

    const deleted = runRetention(db, {
      maxAgeDays: 30,
      keepLastSessions: 1, // protect only "new-session"
      maxFactCount: 50_000,
    });

    // Exactly 5 old facts deleted (source counts fact rows, not CASCADE junction rows)
    expect(deleted).toBe(5);
    // Old facts gone
    expect(wg.queryFacts('old-0.ts')).toHaveLength(0);
    expect(wg.queryFacts('old-1.ts')).toHaveLength(0);
    // New facts remain
    expect(wg.queryFacts('file-0.ts')).toHaveLength(1);
  });

  test('protects facts from recent sessions', () => {
    const DayMs = 24 * 60 * 60 * 1000;

    // Old facts in a "protected" session
    storeFacts(3, { age_ms: 40 * DayMs, sessionId: 'protected-session' });
    // Recent fact in same session to make it "recent"
    wg.storeFact({
      target: 'recent.ts',
      pattern: 'p',
      evidence: [{ file: 'recent.ts', line: 1, snippet: 'x' }],
      oracleName: 'ast-oracle',
      fileHash: 'h',
      sourceFile: 'recent.ts',
      verifiedAt: Date.now(),
      sessionId: 'protected-session',
      confidence: 1.0,
    });

    const db = (wg as any).db as Database;
    const deleted = runRetention(db, {
      maxAgeDays: 30,
      keepLastSessions: 10,
      maxFactCount: 50_000,
    });

    // Old facts in protected session should NOT be deleted
    expect(deleted).toBe(0);
  });

  test('enforces maxFactCount hard cap', () => {
    storeFacts(15, { sessionId: 's1' });

    const db = (wg as any).db as Database;
    const before = db.query('SELECT COUNT(*) as cnt FROM facts').get() as { cnt: number };
    expect(before.cnt).toBe(15);

    const deleted = runRetention(db, {
      maxAgeDays: 365, // effectively disabled
      keepLastSessions: 10,
      maxFactCount: 10,
    });

    // Exactly 5 excess facts deleted (15 - 10 = 5)
    expect(deleted).toBe(5);
    const remaining = db.query('SELECT COUNT(*) as cnt FROM facts').get() as { cnt: number };
    expect(remaining.cnt).toBe(10);
  });

  test('automatic retention via storeFact interval', () => {
    const DayMs = 24 * 60 * 60 * 1000;
    const smallWg = new WorldGraph(':memory:', {
      retentionInterval: 5, // run every 5 stores
      retention: { maxAgeDays: 1, keepLastSessions: 0, maxFactCount: 50_000 },
    });

    // Store 4 old facts (won't trigger retention yet)
    for (let i = 0; i < 4; i++) {
      smallWg.storeFact({
        target: `old-${i}.ts`,
        pattern: 'p',
        evidence: [{ file: `old-${i}.ts`, line: 1, snippet: 'x' }],
        oracleName: 'ast-oracle',
        fileHash: `h-${i}`,
        sourceFile: `old-${i}.ts`,
        verifiedAt: Date.now() - 2 * DayMs,
        confidence: 1.0,
      });
    }

    // 5th store triggers retention
    smallWg.storeFact({
      target: 'new.ts',
      pattern: 'p',
      evidence: [{ file: 'new.ts', line: 1, snippet: 'x' }],
      oracleName: 'ast-oracle',
      fileHash: 'h-new',
      sourceFile: 'new.ts',
      verifiedAt: Date.now(),
      confidence: 1.0,
    });

    // Old facts should be gone, new one remains
    expect(smallWg.queryFacts('old-0.ts')).toHaveLength(0);
    expect(smallWg.queryFacts('new.ts')).toHaveLength(1);

    smallWg.close();
  });

  test('no-op when nothing to delete', () => {
    storeFacts(3, { sessionId: 's1' });

    const db = (wg as any).db as Database;
    const deleted = runRetention(db, {
      maxAgeDays: 365,
      keepLastSessions: 10,
      maxFactCount: 50_000,
    });

    expect(deleted).toBe(0);
  });
});
