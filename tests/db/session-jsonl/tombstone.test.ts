/**
 * Phase 5 — tombstone move + GC + hardDelete integration.
 */
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '../../../src/api/session-manager.ts';
import { ALL_MIGRATIONS, MigrationRunner } from '../../../src/db/migrations/index.ts';
import { JsonlAppender } from '../../../src/db/session-jsonl/appender.ts';
import { makeFsyncPolicy } from '../../../src/db/session-jsonl/fsync-policy.ts';
import { ensureSessionDir, sessionFiles } from '../../../src/db/session-jsonl/paths.ts';
import { IndexRebuilder } from '../../../src/db/session-jsonl/rebuild-index.ts';
import {
  moveToTombstone,
  purgeSessionDir,
  TOMBSTONE_DIR_NAME,
  tombstoneGc,
  tombstonesDir,
} from '../../../src/db/session-jsonl/tombstone.ts';
import { SessionStore } from '../../../src/db/session-store.ts';

let db: Database;
let store: SessionStore;
let manager: SessionManager;
let layout: { sessionsDir: string };

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  new MigrationRunner().migrate(db, ALL_MIGRATIONS);
  store = new SessionStore(db);
  layout = { sessionsDir: mkdtempSync(join(tmpdir(), 'vinyan-tomb-')) };
  manager = new SessionManager(store);
});

afterEach(() => {
  db.close();
});

describe('tombstone primitives', () => {
  test('moveToTombstone moves a live session subdir into .tombstones/<id>-<purgedAt>', () => {
    ensureSessionDir(layout, 's1');
    const dest = moveToTombstone(layout, 's1', 1700);
    expect(dest).toBe(join(tombstonesDir(layout), 's1-1700'));
    expect(existsSync(join(layout.sessionsDir, 's1'))).toBe(false);
    expect(existsSync(join(tombstonesDir(layout), 's1-1700'))).toBe(true);
  });

  test('moveToTombstone is a no-op when no live subdir exists', () => {
    expect(moveToTombstone(layout, 'absent', 1)).toBeNull();
  });

  test('purgeSessionDir removes a live subdir outright', () => {
    ensureSessionDir(layout, 's2');
    expect(purgeSessionDir(layout, 's2')).toBe(true);
    expect(existsSync(join(layout.sessionsDir, 's2'))).toBe(false);
  });
});

describe('tombstoneGc', () => {
  test('prunes only entries older than the retention window', () => {
    // Two tombstones — one fresh, one aged.
    ensureSessionDir(layout, 'fresh');
    moveToTombstone(layout, 'fresh', Date.now());
    ensureSessionDir(layout, 'old');
    const oldDest = moveToTombstone(layout, 'old', Date.now() - 365 * 24 * 60 * 60 * 1000)!;
    // Backdate the directory's mtime via utimes so the GC notices it.
    const ancientSec = (Date.now() - 365 * 24 * 60 * 60 * 1000) / 1000;
    utimesSync(oldDest, ancientSec, ancientSec);

    const dryReport = tombstoneGc(layout, { olderThanMs: 90 * 24 * 60 * 60 * 1000, dryRun: true });
    expect(dryReport.scanned).toBe(2);
    expect(dryReport.pruned).toBe(1);
    expect(dryReport.retained).toBe(1);

    // Dry-run did not delete anything yet.
    expect(readdirSync(tombstonesDir(layout)).sort()).toEqual(
      [
        'fresh-' + ([...readdirSync(tombstonesDir(layout))].find((n) => n.startsWith('fresh-'))?.split('-')[1] ?? '0'),
        [...readdirSync(tombstonesDir(layout))].find((n) => n.startsWith('old-')) ?? '',
      ].sort(),
    );

    const realReport = tombstoneGc(layout, { olderThanMs: 90 * 24 * 60 * 60 * 1000 });
    expect(realReport.pruned).toBe(1);
    expect(realReport.prunedIds.some((id) => id.startsWith('old-'))).toBe(true);
    expect(readdirSync(tombstonesDir(layout)).every((n) => n.startsWith('fresh-'))).toBe(true);
  });

  test('returns an empty report when .tombstones/ does not exist', () => {
    const report = tombstoneGc(layout, { olderThanMs: 1 });
    expect(report.scanned).toBe(0);
    expect(report.pruned).toBe(0);
  });
});

describe('SessionManager.hardDelete tombstone integration', () => {
  test('with default policy=tombstone, hardDelete moves the session subdir into .tombstones/', () => {
    manager.attachJsonlLayer(
      new JsonlAppender({ layout, policy: makeFsyncPolicy('none') }),
      new IndexRebuilder(db, layout),
      undefined,
      undefined,
      { layout, hardDeletePolicy: 'tombstone' },
    );
    const s = manager.create('cli');
    manager.softDelete(s.id);
    expect(existsSync(sessionFiles(layout, s.id).dir)).toBe(true);
    const result = manager.hardDelete(s.id);
    expect(result.applied).toBe(true);

    // Live subdir is gone; a tombstone with this session id was created.
    expect(existsSync(sessionFiles(layout, s.id).dir)).toBe(false);
    const tomb = readdirSync(tombstonesDir(layout));
    expect(tomb.some((n) => n.startsWith(`${s.id}-`))).toBe(true);
  });

  test('with policy=purge, hardDelete deletes the session subdir outright', () => {
    manager.attachJsonlLayer(
      new JsonlAppender({ layout, policy: makeFsyncPolicy('none') }),
      new IndexRebuilder(db, layout),
      undefined,
      undefined,
      { layout, hardDeletePolicy: 'purge' },
    );
    const s = manager.create('cli');
    manager.softDelete(s.id);
    manager.hardDelete(s.id);
    expect(existsSync(sessionFiles(layout, s.id).dir)).toBe(false);
    // No tombstone exists either.
    if (existsSync(tombstonesDir(layout))) {
      expect(readdirSync(tombstonesDir(layout))).toEqual([]);
    }
  });

  test('without a wired layout, hardDelete is fs-side a no-op (legacy path)', () => {
    // attachJsonlLayer NOT called → hardDeletePolicy stays default but
    // jsonlLayout is undefined; the SessionManager skips the fs branch.
    const s = manager.create('cli');
    manager.softDelete(s.id);
    const result = manager.hardDelete(s.id);
    expect(result.applied).toBe(true);
    // No tombstone dir was created — no fs hook was wired.
    expect(existsSync(tombstonesDir(layout))).toBe(false);
  });
});

describe('TOMBSTONE_DIR_NAME contract', () => {
  test('lives at <sessionsDir>/.tombstones', () => {
    expect(tombstonesDir(layout)).toBe(join(layout.sessionsDir, TOMBSTONE_DIR_NAME));
  });
});
