/**
 * Tests for OracleAccuracyStore — retrospective oracle accuracy tracking.
 *
 * Validates:
 *   - Verdict recording (insert)
 *   - Outcome resolution by gate run ID
 *   - Outcome resolution by affected files
 *   - Stale record sweep (no-negative-signal → confirmed_correct)
 *   - Accuracy computation with bootstrap protection (< 10 → null)
 *   - Accuracy computation with sufficient data
 *   - UNIQUE constraint on (gate_run_id, oracle_name)
 *   - Window filter for time-bounded queries
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { OracleAccuracyStore, type OracleAccuracyRecord } from '../../src/db/oracle-accuracy-store.ts';

function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  return db;
}

function makeRecord(
  overrides: Partial<Omit<OracleAccuracyRecord, 'outcome' | 'outcomeTimestamp'>> = {},
): Omit<OracleAccuracyRecord, 'outcome' | 'outcomeTimestamp'> {
  return {
    id: `rec-${Math.random().toString(36).slice(2, 8)}`,
    oracleName: 'type',
    gateRunId: 'gate-001',
    verdict: 'pass',
    confidence: 1.0,
    tier: 'known',
    timestamp: Date.now(),
    affectedFiles: ['src/foo.ts'],
    ...overrides,
  };
}

describe('OracleAccuracyStore', () => {
  let db: Database;
  let store: OracleAccuracyStore;

  beforeEach(() => {
    db = createTestDb();
    store = new OracleAccuracyStore(db);
  });

  afterEach(() => {
    db.close();
  });

  test('recordVerdict inserts correctly', () => {
    const record = makeRecord({ id: 'rec-001', oracleName: 'ast' });
    store.recordVerdict(record);

    const row = db.prepare('SELECT * FROM oracle_accuracy WHERE id = ?').get('rec-001') as any;
    expect(row).toBeDefined();
    expect(row.oracle_name).toBe('ast');
    expect(row.gate_run_id).toBe('gate-001');
    expect(row.verdict).toBe('pass');
    expect(row.confidence).toBe(1.0);
    expect(row.tier).toBe('known');
    expect(row.outcome).toBe('pending');
    expect(JSON.parse(row.affected_files)).toEqual(['src/foo.ts']);
  });

  test('resolveOutcome updates all records for a gate run', () => {
    store.recordVerdict(makeRecord({ id: 'r1', oracleName: 'ast', gateRunId: 'gate-A' }));
    store.recordVerdict(makeRecord({ id: 'r2', oracleName: 'type', gateRunId: 'gate-A' }));
    store.recordVerdict(makeRecord({ id: 'r3', oracleName: 'lint', gateRunId: 'gate-B' }));

    store.resolveOutcome('gate-A', 'confirmed_correct');

    const rowA1 = db.prepare('SELECT outcome FROM oracle_accuracy WHERE id = ?').get('r1') as any;
    const rowA2 = db.prepare('SELECT outcome FROM oracle_accuracy WHERE id = ?').get('r2') as any;
    const rowB = db.prepare('SELECT outcome FROM oracle_accuracy WHERE id = ?').get('r3') as any;

    expect(rowA1.outcome).toBe('confirmed_correct');
    expect(rowA2.outcome).toBe('confirmed_correct');
    expect(rowB.outcome).toBe('pending'); // Different gate run — untouched
  });

  test('resolveOutcome only updates pending records', () => {
    store.recordVerdict(makeRecord({ id: 'r1', oracleName: 'ast', gateRunId: 'gate-A' }));
    store.resolveOutcome('gate-A', 'confirmed_correct');
    // Try to re-resolve — should be no-op since record is no longer pending
    store.resolveOutcome('gate-A', 'confirmed_wrong');

    const row = db.prepare('SELECT outcome FROM oracle_accuracy WHERE id = ?').get('r1') as any;
    expect(row.outcome).toBe('confirmed_correct'); // First resolution sticks
  });

  test('resolveByFiles resolves records sharing affected files', () => {
    store.recordVerdict(makeRecord({
      id: 'r1', oracleName: 'type', gateRunId: 'gate-A',
      affectedFiles: ['src/foo.ts', 'src/bar.ts'],
    }));
    store.recordVerdict(makeRecord({
      id: 'r2', oracleName: 'ast', gateRunId: 'gate-B',
      affectedFiles: ['src/baz.ts'],
    }));
    store.recordVerdict(makeRecord({
      id: 'r3', oracleName: 'lint', gateRunId: 'gate-C',
      affectedFiles: ['src/bar.ts'],
    }));

    store.resolveByFiles(['src/bar.ts'], 'confirmed_correct');

    const row1 = db.prepare('SELECT outcome FROM oracle_accuracy WHERE id = ?').get('r1') as any;
    const row2 = db.prepare('SELECT outcome FROM oracle_accuracy WHERE id = ?').get('r2') as any;
    const row3 = db.prepare('SELECT outcome FROM oracle_accuracy WHERE id = ?').get('r3') as any;

    expect(row1.outcome).toBe('confirmed_correct'); // shares src/bar.ts
    expect(row2.outcome).toBe('pending');            // no overlap
    expect(row3.outcome).toBe('confirmed_correct'); // shares src/bar.ts
  });

  test('resolveByFiles with empty file list is a no-op', () => {
    store.recordVerdict(makeRecord({ id: 'r1' }));
    store.resolveByFiles([], 'confirmed_wrong');

    const row = db.prepare('SELECT outcome FROM oracle_accuracy WHERE id = ?').get('r1') as any;
    expect(row.outcome).toBe('pending');
  });

  test('sweepStaleRecords marks old pending records as confirmed_correct', () => {
    const oldTimestamp = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago
    const recentTimestamp = Date.now() - 10 * 1000;        // 10 seconds ago

    store.recordVerdict(makeRecord({ id: 'r-old', gateRunId: 'gate-old', timestamp: oldTimestamp }));
    store.recordVerdict(makeRecord({ id: 'r-recent', gateRunId: 'gate-recent', timestamp: recentTimestamp }));

    const swept = store.sweepStaleRecords(1 * 60 * 60 * 1000); // 1 hour threshold

    expect(swept).toBe(1);

    const rowOld = db.prepare('SELECT outcome FROM oracle_accuracy WHERE id = ?').get('r-old') as any;
    const rowRecent = db.prepare('SELECT outcome FROM oracle_accuracy WHERE id = ?').get('r-recent') as any;

    expect(rowOld.outcome).toBe('confirmed_correct');
    expect(rowRecent.outcome).toBe('pending');
  });

  test('sweepStaleRecords does not touch already-resolved records', () => {
    const oldTimestamp = Date.now() - 2 * 60 * 60 * 1000;
    store.recordVerdict(makeRecord({ id: 'r1', gateRunId: 'g1', timestamp: oldTimestamp }));
    store.resolveOutcome('g1', 'confirmed_wrong');

    const swept = store.sweepStaleRecords(1 * 60 * 60 * 1000);
    expect(swept).toBe(0);

    const row = db.prepare('SELECT outcome FROM oracle_accuracy WHERE id = ?').get('r1') as any;
    expect(row.outcome).toBe('confirmed_wrong'); // Unchanged
  });

  test('computeOracleAccuracy returns null accuracy when < 10 resolved verdicts', () => {
    // Insert 5 resolved records — below bootstrap threshold
    for (let i = 0; i < 5; i++) {
      store.recordVerdict(makeRecord({
        id: `r${i}`, oracleName: 'type', gateRunId: `gate-${i}`,
      }));
      store.resolveOutcome(`gate-${i}`, 'confirmed_correct');
    }

    const stats = store.computeOracleAccuracy('type');
    expect(stats.total).toBe(5);
    expect(stats.correct).toBe(5);
    expect(stats.wrong).toBe(0);
    expect(stats.pending).toBe(0);
    expect(stats.accuracy).toBeNull(); // Bootstrap protection
  });

  test('computeOracleAccuracy returns correct accuracy when >= 10 resolved verdicts', () => {
    // 8 correct + 2 wrong = 10 resolved
    for (let i = 0; i < 8; i++) {
      store.recordVerdict(makeRecord({
        id: `correct-${i}`, oracleName: 'type', gateRunId: `gate-c-${i}`,
      }));
      store.resolveOutcome(`gate-c-${i}`, 'confirmed_correct');
    }
    for (let i = 0; i < 2; i++) {
      store.recordVerdict(makeRecord({
        id: `wrong-${i}`, oracleName: 'type', gateRunId: `gate-w-${i}`,
      }));
      store.resolveOutcome(`gate-w-${i}`, 'confirmed_wrong');
    }
    // Add 3 pending — should not affect accuracy ratio
    for (let i = 0; i < 3; i++) {
      store.recordVerdict(makeRecord({
        id: `pending-${i}`, oracleName: 'type', gateRunId: `gate-p-${i}`,
      }));
    }

    const stats = store.computeOracleAccuracy('type');
    expect(stats.total).toBe(13);
    expect(stats.correct).toBe(8);
    expect(stats.wrong).toBe(2);
    expect(stats.pending).toBe(3);
    expect(stats.accuracy).toBe(0.8); // 8 / (8 + 2)
  });

  test('computeOracleAccuracy counts correctly_rejected and false_alarm', () => {
    for (let i = 0; i < 5; i++) {
      store.recordVerdict(makeRecord({
        id: `cc-${i}`, oracleName: 'ast', gateRunId: `gate-cc-${i}`,
      }));
      store.resolveOutcome(`gate-cc-${i}`, 'confirmed_correct');
    }
    for (let i = 0; i < 3; i++) {
      store.recordVerdict(makeRecord({
        id: `cr-${i}`, oracleName: 'ast', gateRunId: `gate-cr-${i}`,
      }));
      store.resolveOutcome(`gate-cr-${i}`, 'correctly_rejected');
    }
    store.recordVerdict(makeRecord({ id: 'cw-0', oracleName: 'ast', gateRunId: 'gate-cw-0' }));
    store.resolveOutcome('gate-cw-0', 'confirmed_wrong');
    store.recordVerdict(makeRecord({ id: 'fa-0', oracleName: 'ast', gateRunId: 'gate-fa-0' }));
    store.resolveOutcome('gate-fa-0', 'false_alarm');

    const stats = store.computeOracleAccuracy('ast');
    expect(stats.correct).toBe(8);
    expect(stats.wrong).toBe(2);
    expect(stats.accuracy).toBe(0.8);
  });

  test('duplicate gate_run_id + oracle_name is handled (UNIQUE constraint)', () => {
    store.recordVerdict(makeRecord({ id: 'r1', oracleName: 'type', gateRunId: 'gate-dup' }));
    // Second insert with same gate_run_id + oracle_name should be ignored (INSERT OR IGNORE)
    store.recordVerdict(makeRecord({ id: 'r2', oracleName: 'type', gateRunId: 'gate-dup' }));

    const count = db.prepare(
      'SELECT COUNT(*) as cnt FROM oracle_accuracy WHERE gate_run_id = ? AND oracle_name = ?',
    ).get('gate-dup', 'type') as { cnt: number };
    expect(count.cnt).toBe(1);
  });

  test('window filter only counts recent records', () => {
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;

    // 5 old records (30 days ago) — outside 7-day window
    for (let i = 0; i < 5; i++) {
      store.recordVerdict(makeRecord({
        id: `old-${i}`, oracleName: 'type', gateRunId: `gate-old-${i}`,
        timestamp: now - 30 * oneDay,
      }));
      store.resolveOutcome(`gate-old-${i}`, 'confirmed_correct');
    }

    // 10 recent records (1 day ago) — inside 7-day window
    for (let i = 0; i < 8; i++) {
      store.recordVerdict(makeRecord({
        id: `recent-${i}`, oracleName: 'type', gateRunId: `gate-recent-${i}`,
        timestamp: now - 1 * oneDay,
      }));
      store.resolveOutcome(`gate-recent-${i}`, 'confirmed_correct');
    }
    for (let i = 0; i < 2; i++) {
      store.recordVerdict(makeRecord({
        id: `recent-wrong-${i}`, oracleName: 'type', gateRunId: `gate-rw-${i}`,
        timestamp: now - 1 * oneDay,
      }));
      store.resolveOutcome(`gate-rw-${i}`, 'confirmed_wrong');
    }

    // Without window: 15 total, 13 correct, 2 wrong
    const allTime = store.computeOracleAccuracy('type');
    expect(allTime.total).toBe(15);
    expect(allTime.correct).toBe(13);
    expect(allTime.accuracy).toBeCloseTo(13 / 15, 5);

    // With 7-day window: 10 total, 8 correct, 2 wrong
    const windowed = store.computeOracleAccuracy('type', 7);
    expect(windowed.total).toBe(10);
    expect(windowed.correct).toBe(8);
    expect(windowed.wrong).toBe(2);
    expect(windowed.accuracy).toBe(0.8);
  });

  test('computeOracleAccuracy returns zeros for unknown oracle', () => {
    const stats = store.computeOracleAccuracy('nonexistent');
    expect(stats.total).toBe(0);
    expect(stats.correct).toBe(0);
    expect(stats.wrong).toBe(0);
    expect(stats.pending).toBe(0);
    expect(stats.accuracy).toBeNull();
  });

  test('resolveOutcome sets outcome_timestamp', () => {
    const before = Date.now();
    store.recordVerdict(makeRecord({ id: 'r1', gateRunId: 'gate-ts' }));
    store.resolveOutcome('gate-ts', 'confirmed_correct');
    const after = Date.now();

    const row = db.prepare('SELECT outcome_timestamp FROM oracle_accuracy WHERE id = ?').get('r1') as any;
    expect(row.outcome_timestamp).toBeGreaterThanOrEqual(before);
    expect(row.outcome_timestamp).toBeLessThanOrEqual(after);
  });
});
