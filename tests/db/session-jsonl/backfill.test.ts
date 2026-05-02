/**
 * Phase 4 backfill — synthesize events.jsonl from existing SQLite.
 *
 * Asserts:
 *   1. Round trip: SQLite session → backfill → JSONL → IndexRebuilder
 *      reproduces the same SQLite state (verifier-level parity).
 *   2. Idempotent: re-running on a session that already has events.jsonl
 *      is a skip (skippedExisting +1).
 *   3. `--since` filter excludes old sessions.
 *   4. `--dry-run` reports without writing.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALL_MIGRATIONS, MigrationRunner } from '../../../src/db/migrations/index.ts';
import { JsonlAppender } from '../../../src/db/session-jsonl/appender.ts';
import { backfillSessions, parseDuration } from '../../../src/db/session-jsonl/backfill.ts';
import { makeFsyncPolicy } from '../../../src/db/session-jsonl/fsync-policy.ts';
import { sessionFiles } from '../../../src/db/session-jsonl/paths.ts';
import { JsonlReader } from '../../../src/db/session-jsonl/reader.ts';
import { IndexRebuilder } from '../../../src/db/session-jsonl/rebuild-index.ts';
import { SessionVerifier } from '../../../src/db/session-jsonl/verifier.ts';

let db: Database;
let layout: { sessionsDir: string };

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  layout = { sessionsDir: mkdtempSync(join(tmpdir(), 'vinyan-backfill-')) };
});

afterEach(() => {
  db.close();
});

function seedLegacySession(id: string, opts: { updatedAt?: number; title?: string } = {}): void {
  const now = opts.updatedAt ?? Date.now();
  db.run(
    `INSERT INTO session_store (id, source, created_at, status, working_memory_json, compaction_json, updated_at, title, description, archived_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, 'cli', now, 'active', null, null, now, opts.title ?? null, null, null, null],
  );
  db.run(
    `INSERT INTO session_tasks
        (session_id, task_id, task_input_json, status, result_json, created_at, updated_at, archived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      't1',
      JSON.stringify({ id: 't1', goal: 'do thing' }),
      'completed',
      JSON.stringify({ ok: true }),
      now,
      now,
      null,
    ],
  );
  db.run(
    `INSERT INTO session_turns (id, session_id, seq, role, blocks_json, token_count_json, task_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `${id}-turn-u`,
      id,
      0,
      'user',
      JSON.stringify([{ type: 'text', text: 'hi' }]),
      '{"input":0,"output":0,"cacheRead":0,"cacheCreation":0}',
      null,
      now,
    ],
  );
  db.run(
    `INSERT INTO session_turns (id, session_id, seq, role, blocks_json, token_count_json, task_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      `${id}-turn-a`,
      id,
      1,
      'assistant',
      JSON.stringify([{ type: 'text', text: 'hello' }]),
      '{"input":0,"output":5,"cacheRead":0,"cacheCreation":0}',
      't1',
      now,
    ],
  );
}

describe('backfillSessions', () => {
  test('synthesizes events.jsonl that the rebuilder + verifier accept', () => {
    seedLegacySession('s-A', { title: 'first' });
    const appender = new JsonlAppender({ layout, policy: makeFsyncPolicy('none') });
    const report = backfillSessions(db, layout, appender);
    expect(report.scanned).toBe(1);
    expect(report.backfilled).toBe(1);
    expect(report.linesWritten).toBeGreaterThan(0);

    const files = sessionFiles(layout, 's-A');
    expect(existsSync(files.events)).toBe(true);

    // The events log replays through IndexRebuilder, then the verifier
    // confirms the rebuilt SQLite matches the JSONL fold.
    const rebuilder = new IndexRebuilder(db, layout);
    rebuilder.rebuildSessionIndex('s-A');
    const verifier = new SessionVerifier(db, layout);
    const verdict = verifier.verify('s-A');
    expect(verdict.matches).toBe(true);

    // Spot-check the JSONL line kinds so a regression on causal order is
    // caught here, not just at verifier level.
    const lines = new JsonlReader(layout).scanAll('s-A').lines.map((l) => l.line.kind);
    expect(lines[0]).toBe('session.created');
    expect(lines).toContain('task.created');
    expect(lines).toContain('task.status.changed');
    expect(lines).toContain('turn.appended');
  });

  test('is idempotent — re-running skips sessions that already have events.jsonl', () => {
    seedLegacySession('s-B');
    const appender = new JsonlAppender({ layout, policy: makeFsyncPolicy('none') });
    const first = backfillSessions(db, layout, appender);
    expect(first.backfilled).toBe(1);
    const second = backfillSessions(db, layout, appender);
    expect(second.backfilled).toBe(0);
    expect(second.skippedExisting).toBe(1);
  });

  test('--since cutoff excludes old sessions', () => {
    const fortyDaysAgo = Date.now() - 40 * 24 * 60 * 60 * 1000;
    seedLegacySession('s-old', { updatedAt: fortyDaysAgo });
    seedLegacySession('s-new');
    const appender = new JsonlAppender({ layout, policy: makeFsyncPolicy('none') });
    const report = backfillSessions(db, layout, appender, { sinceMs: 30 * 24 * 60 * 60 * 1000 });
    expect(report.backfilled).toBe(1);
    expect(report.skippedTooOld).toBe(1);

    expect(existsSync(sessionFiles(layout, 's-new').events)).toBe(true);
    expect(existsSync(sessionFiles(layout, 's-old').events)).toBe(false);
  });

  test('--dry-run reports counts but does not write', () => {
    seedLegacySession('s-dry');
    const appender = new JsonlAppender({ layout, policy: makeFsyncPolicy('none') });
    const report = backfillSessions(db, layout, appender, { dryRun: true });
    expect(report.backfilled).toBe(1);
    expect(report.linesWritten).toBeGreaterThan(0);
    // No events.jsonl was actually written.
    expect(existsSync(sessionFiles(layout, 's-dry').events)).toBe(false);
  });
});

describe('parseDuration', () => {
  test('accepts d/h/m/s suffixes and returns ms', () => {
    expect(parseDuration('30d')).toBe(30 * 24 * 60 * 60 * 1000);
    expect(parseDuration('48h')).toBe(48 * 60 * 60 * 1000);
    expect(parseDuration('45m')).toBe(45 * 60 * 1000);
    expect(parseDuration('60s')).toBe(60 * 1000);
  });

  test('returns undefined on garbage input', () => {
    expect(parseDuration('forever')).toBeUndefined();
    expect(parseDuration('30days')).toBeUndefined();
    expect(parseDuration('')).toBeUndefined();
  });
});
