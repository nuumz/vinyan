/**
 * Phase 5 — startup recovery scan.
 *
 * Asserts:
 *   1. Sessions whose last_line_offset matches active-segment size are
 *      reported as in-sync (no rebuild fires).
 *   2. Sessions where the active segment grew past last_line_offset
 *      (drift = JSONL appended without index update) are rebuilt.
 *   3. Sessions without any JSONL log (legacy / pre-Phase-2) are
 *      reported as missing-jsonl and skipped — never errors.
 *   4. `--dry-run` detects drift without rebuilding.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../../../src/api/session-manager.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../../src/db/migrations/index.ts';
import { JsonlAppender } from '../../../src/db/session-jsonl/appender.ts';
import { makeFsyncPolicy } from '../../../src/db/session-jsonl/fsync-policy.ts';
import { sessionFiles } from '../../../src/db/session-jsonl/paths.ts';
import { IndexRebuilder } from '../../../src/db/session-jsonl/rebuild-index.ts';
import { recoverStartup } from '../../../src/db/session-jsonl/recovery.ts';
import { SessionStore } from '../../../src/db/session-store.ts';

let db: Database;
let store: SessionStore;
let manager: SessionManager;
let layout: { sessionsDir: string };

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  store = new SessionStore(db);
  layout = { sessionsDir: mkdtempSync(join(tmpdir(), 'vinyan-recovery-')) };
  manager = new SessionManager(store);
  manager.attachJsonlLayer(
    new JsonlAppender({ layout, policy: makeFsyncPolicy('none') }),
    new IndexRebuilder(db, layout),
  );
});

afterEach(() => {
  db.close();
});

describe('Startup recovery', () => {
  test('reports in-sync sessions when offsets match', () => {
    const s = manager.create('cli');
    manager.recordUserTurn(s.id, 'hi');
    const report = recoverStartup(db, layout);
    expect(report.scanned).toBeGreaterThanOrEqual(1);
    expect(report.drifted).toBe(0);
    expect(report.inSync).toBeGreaterThanOrEqual(1);
  });

  test('detects drift when JSONL appended past last_line_offset', () => {
    const s = manager.create('cli');
    manager.recordUserTurn(s.id, 'hi');

    // Simulate a crash-after-fsync: append a bogus line directly to
    // events.jsonl without going through SessionManager (so SQLite's
    // last_line_offset stays behind).
    const drift =
      '{"v":1,"lineId":"orphan","parentLineId":null,"sessionId":"' +
      s.id +
      '","seq":99,"ts":1,"actor":{"kind":"system"},"kind":"session.metadata.updated","payload":{}}\n';
    appendFileSync(sessionFiles(layout, s.id).events, drift);

    const before = recoverStartup(db, layout, { dryRun: true });
    expect(before.drifted).toBe(1);

    // Real run rebuilds — last_line_offset moves up to actual size.
    const report = recoverStartup(db, layout);
    expect(report.drifted).toBe(1);

    // After recovery, a re-scan reports in-sync.
    const after = recoverStartup(db, layout, { dryRun: true });
    expect(after.drifted).toBe(0);
  });

  test('skips sessions that never wrote a JSONL log', () => {
    // Insert a session_store row directly — never went through Phase 2
    // dual-write, so no events.jsonl exists.
    const id = 'legacy';
    const now = Date.now();
    db.run('INSERT INTO session_store (id, source, created_at, status, updated_at) VALUES (?, ?, ?, ?, ?)', [
      id,
      'cli',
      now,
      'active',
      now,
    ]);
    const report = recoverStartup(db, layout);
    expect(report.missingJsonl).toBeGreaterThanOrEqual(1);
    const entry = report.perSession.find((p) => p.sessionId === id);
    expect(entry?.status).toBe('missing-jsonl');
  });

  test('--dry-run does not rebuild', () => {
    const s = manager.create('cli');
    manager.recordUserTurn(s.id, 'hi');
    const drift =
      '{"v":1,"lineId":"orphan","parentLineId":null,"sessionId":"' +
      s.id +
      '","seq":99,"ts":1,"actor":{"kind":"system"},"kind":"session.metadata.updated","payload":{}}\n';
    appendFileSync(sessionFiles(layout, s.id).events, drift);

    const dry = recoverStartup(db, layout, { dryRun: true });
    expect(dry.drifted).toBe(1);

    // Re-running dry-run still reports drift — no rebuild happened.
    const dry2 = recoverStartup(db, layout, { dryRun: true });
    expect(dry2.drifted).toBe(1);
  });
});
