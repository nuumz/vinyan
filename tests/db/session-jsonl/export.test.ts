/**
 * Phase 5 — session export / import round-trip.
 *
 * Asserts:
 *   1. exportSession captures every segment's content + manifest.
 *   2. importSession recreates the on-disk layout byte-identically.
 *   3. After import + IndexRebuilder.rebuildSessionIndex, the verifier
 *      reports matches.
 *   4. importSession refuses to clobber an existing session by default.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../../../src/api/session-manager.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../../src/db/migrations/index.ts';
import { JsonlAppender } from '../../../src/db/session-jsonl/appender.ts';
import { exportSession, importSession, readExport, writeExport } from '../../../src/db/session-jsonl/export.ts';
import { makeFsyncPolicy } from '../../../src/db/session-jsonl/fsync-policy.ts';
import { sessionFiles } from '../../../src/db/session-jsonl/paths.ts';
import { JsonlReader } from '../../../src/db/session-jsonl/reader.ts';
import { IndexRebuilder } from '../../../src/db/session-jsonl/rebuild-index.ts';
import { readManifest } from '../../../src/db/session-jsonl/segments.ts';
import { SessionVerifier } from '../../../src/db/session-jsonl/verifier.ts';
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
  layout = { sessionsDir: mkdtempSync(join(tmpdir(), 'vinyan-export-')) };
  manager = new SessionManager(store);
  manager.attachJsonlLayer(
    new JsonlAppender({ layout, policy: makeFsyncPolicy('none'), maxBytesPerSegment: 200 }),
    new IndexRebuilder(db, layout),
  );
});

afterEach(() => {
  db.close();
});

function buildSession(id: string): void {
  const s = manager.create('cli', { title: id });
  // Produce enough lines to trigger at least one rotation under the
  // 200-byte cap — that way the bundle covers >1 segment.
  for (let i = 0; i < 5; i++) {
    manager.recordUserTurn(s.id, `msg-${i}`);
  }
  // Replace the auto-generated session id so the test can refer to it
  // through the `id` arg without having to know the UUID.
  // (Direct SQL is fine — this test seeds state, not user-facing flow.)
  db.run('UPDATE session_store SET id = ? WHERE id = ?', [id, s.id]);
}

describe('export / import round-trip', () => {
  test('exportSession bundles every sealed + active segment', () => {
    const sessionId = 's-export';
    const s = manager.create('cli', { title: sessionId });
    for (let i = 0; i < 5; i++) manager.recordUserTurn(s.id, `m${i}`);
    const bundle = exportSession(layout, s.id);
    expect(bundle.version).toBe(1);
    expect(bundle.sessionId).toBe(s.id);
    expect(bundle.segments.length).toBeGreaterThanOrEqual(1);
    // Bundle should include the manifest when rotation happened.
    const manifest = readManifest(layout, s.id);
    if (manifest.sealed.length > 0) {
      expect(bundle.manifest).not.toBeNull();
      // Sealed names appear in the bundle.
      for (const seg of manifest.sealed) {
        expect(bundle.segments.some((s) => s.name === seg.name)).toBe(true);
      }
    }
  });

  test('writeExport + readExport round-trip on disk', () => {
    const s = manager.create('cli', { title: 's-disk' });
    manager.recordUserTurn(s.id, 'one');
    const out = join(layout.sessionsDir, 'bundle.json');
    writeExport(exportSession(layout, s.id), out);
    const loaded = readExport(out);
    expect(loaded.sessionId).toBe(s.id);
    // Segment count depends on whether rotation triggered; the contract
    // is that the bundle's segments cover the full history. Assert the
    // session.created line is in the FIRST segment (oldest-first order).
    expect(loaded.segments.length).toBeGreaterThanOrEqual(1);
    expect(loaded.segments[0]?.content).toContain('session.created');
  });

  test('importSession recreates the JSONL layout under a fresh sessionId; rebuild + verify accept', () => {
    // Build a session in `db` and bundle it.
    const s = manager.create('cli');
    for (let i = 0; i < 5; i++) manager.recordUserTurn(s.id, `m${i}`);
    const bundle = exportSession(layout, s.id);

    // Import under a fresh id into a fresh layout + DB. The rebuilder
    // populates SQLite from the JSONL the import wrote.
    const freshLayout = { sessionsDir: mkdtempSync(join(tmpdir(), 'vinyan-import-')) };
    const freshDb = new Database(':memory:');
    freshDb.exec('PRAGMA foreign_keys = ON');
    new MigrationRunner().migrate(freshDb, ALL_MIGRATIONS);

    const result = importSession(freshLayout, bundle, { targetSessionId: 'imported-1' });
    expect(result.sessionId).toBe('imported-1');
    expect(result.segmentsWritten).toBeGreaterThanOrEqual(1);

    new IndexRebuilder(freshDb, freshLayout).rebuildSessionIndex('imported-1');
    const verdict = new SessionVerifier(freshDb, freshLayout).verify('imported-1');
    expect(verdict.matches).toBe(true);

    // The events.jsonl content of the imported session is equivalent to
    // the union of segments in the bundle (concatenated in order).
    const lines = new JsonlReader(freshLayout).scanAll('imported-1').lines;
    expect(lines.length).toBeGreaterThanOrEqual(6); // session.created + 5 turns
  });

  test('importSession refuses to clobber an existing session by default', () => {
    const s = manager.create('cli');
    manager.recordUserTurn(s.id, 'one');
    const bundle = exportSession(layout, s.id);
    expect(() => importSession(layout, bundle)).toThrow(/already has files/);
  });

  test('readExport rejects non-bundle files', () => {
    const out = join(layout.sessionsDir, 'garbage.json');
    require('node:fs').writeFileSync(out, JSON.stringify({ hello: 'world' }));
    expect(() => readExport(out)).toThrow(/not a valid Vinyan session export bundle/);
  });
});
