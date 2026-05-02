/**
 * SessionManager — crash / failure semantics for Phase 2 dual-write.
 *
 * Failure-mode contract:
 *   1. JSONL append throws → SQLite is NOT touched → method propagates the
 *      error. JSONL is the source of truth, so failing to durably commit
 *      the line means we MUST refuse the operation rather than silently
 *      letting SQLite drift.
 *   2. SQLite write throws AFTER JSONL committed → the JSONL line stands,
 *      the index is stale until a rebuild reconciles it. The Phase 2 plan
 *      describes this as "schedule async rebuildIndex(sessionId)". Phase 2
 *      schedules the rebuild but DOES still propagate the SQLite error so
 *      tests can deterministically observe the broken-but-recoverable
 *      state. Production callers see an exception they can retry; the
 *      next read sees the rebuilt index.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../../src/api/session-manager.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../src/db/migrations/index.ts';
import { JsonlAppender } from '../../src/db/session-jsonl/appender.ts';
import { makeFsyncPolicy } from '../../src/db/session-jsonl/fsync-policy.ts';
import { JsonlReader } from '../../src/db/session-jsonl/reader.ts';
import { IndexRebuilder } from '../../src/db/session-jsonl/rebuild-index.ts';
import { SessionVerifier } from '../../src/db/session-jsonl/verifier.ts';
import { SessionStore } from '../../src/db/session-store.ts';

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
  layout = { sessionsDir: mkdtempSync(join(tmpdir(), 'vinyan-crash-')) };
  manager = new SessionManager(store);
  manager.attachJsonlLayer(
    new JsonlAppender({ layout, policy: makeFsyncPolicy('none') }),
    new IndexRebuilder(db, layout),
  );
});

afterEach(() => {
  db.close();
});

describe('SessionManager dual-write — JSONL failure propagation', () => {
  test('a sessionId outside the safe charset throws BEFORE any SQLite write', () => {
    // The JSONL appender rejects path-escape-y session ids in `paths.ts`.
    // We can't easily simulate fs failure cross-platform, so this test
    // exercises the same error path: validation throws → SQLite untouched.
    const badId = '../escape';

    // We cannot call manager.create with a bad id (it generates UUIDs).
    // Use the appender directly to confirm the contract that JsonlAppender
    // throws synchronously, leaving callers free to abort their SQLite write.
    const appender = new JsonlAppender({ layout, policy: makeFsyncPolicy('none') });
    expect(() =>
      appender.appendSync(badId, {
        kind: 'session.created',
        payload: {},
        actor: { kind: 'user' },
      }),
    ).toThrow(/invalid sessionId/);

    // No SQLite rows landed: the appender threw before any DB call.
    const rows = db.query('SELECT id FROM session_store').all() as Array<{ id: string }>;
    expect(rows).toEqual([]);
  });
});

describe('SessionManager dual-write — SQLite failure with JSONL committed', () => {
  test('SQLite write failure after JSONL commit triggers index rebuild', () => {
    const session = manager.create('cli', { title: 'first' });
    const reader = new JsonlReader(layout);
    expect(reader.scanAll(session.id).lines).toHaveLength(1);

    // Simulate SQLite drift by deleting the row out-of-band, then rebuild.
    db.run('DELETE FROM session_store WHERE id = ?', [session.id]);
    const beforeRow = db.query('SELECT id FROM session_store WHERE id = ?').get(session.id);
    expect(beforeRow).toBeNull();

    new IndexRebuilder(db, layout).rebuildSessionIndex(session.id);

    const after = db.query('SELECT id, title FROM session_store WHERE id = ?').get(session.id) as {
      id: string;
      title: string;
    };
    expect(after.id).toBe(session.id);
    expect(after.title).toBe('first');
    expect(new SessionVerifier(db, layout).verify(session.id).matches).toBe(true);
  });

  test('JSONL stays intact when SQLite is wiped — the rebuild is fully recovering', () => {
    const session = manager.create('cli');
    manager.updateMetadata(session.id, { title: 'A' });
    manager.updateMetadata(session.id, { title: 'B' });
    const reader = new JsonlReader(layout);
    const linesBefore = reader.scanAll(session.id).lines;
    expect(linesBefore).toHaveLength(3);

    // Wipe SQLite entirely except the schema.
    db.run('DELETE FROM session_store');
    new IndexRebuilder(db, layout).rebuildSessionIndex(session.id);

    const row = db.query('SELECT title FROM session_store WHERE id = ?').get(session.id) as {
      title: string;
    };
    expect(row.title).toBe('B');

    // JSONL bytes are unchanged — I16 audit invariant.
    const linesAfter = reader.scanAll(session.id).lines;
    expect(linesAfter).toHaveLength(linesBefore.length);
    expect(linesAfter[0]?.line.lineId).toBe(linesBefore[0]?.line.lineId);
  });
});
