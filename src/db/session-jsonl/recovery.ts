/**
 * Phase 5 — startup recovery scan.
 *
 * Compares each `session_store.last_line_offset` against the actual
 * size of the active `events.jsonl`. Drift means a previous process
 * appended a JSONL line but didn't update SQLite (crash between fsync
 * and index update — the failure mode covered by Phase 2's
 * "schedule async rebuild" branch). On startup we walk every session
 * and trigger a full rebuild via `IndexRebuilder` for any drift.
 *
 * Full rebuild (vs partial) is intentional for Phase 5:
 *
 *   - It uses the existing IndexRebuilder, which is well-tested.
 *   - It's idempotent — rerunning costs nothing if the index is
 *     already in sync.
 *   - At Phase 5 scale (hundreds of sessions, MB-sized JSONL each)
 *     it's fast enough; partial-rebuild is a Phase 6 optimization.
 */
import type { Database } from 'bun:sqlite';
import { existsSync, statSync } from 'node:fs';
import { type SessionDirLayout, sessionFiles } from './paths.ts';
import { IndexRebuilder } from './rebuild-index.ts';

export interface RecoveryReport {
  /** Sessions inspected. */
  scanned: number;
  /** Sessions whose index was in sync (no rebuild needed). */
  inSync: number;
  /** Sessions that drifted and were rebuilt. */
  drifted: number;
  /** Sessions whose JSONL log is missing (legacy / pre-Phase-2). Skipped. */
  missingJsonl: number;
  /** Per-session detail. */
  perSession: Array<{
    sessionId: string;
    status: 'in-sync' | 'drifted' | 'missing-jsonl';
    expectedOffset: number | null;
    actualSize: number | null;
  }>;
}

export interface RecoveryOptions {
  /** When true, detect drift but do NOT rebuild — useful for `--dry-run`. */
  dryRun?: boolean;
}

/**
 * Walk every session in `session_store` and compare the recorded
 * `last_line_offset` to the active segment size on disk. Rebuild any
 * session that drifted. Sessions without a JSONL log (legacy / pre-
 * Phase-2) are skipped.
 */
export function recoverStartup(db: Database, layout: SessionDirLayout, opts: RecoveryOptions = {}): RecoveryReport {
  const { dryRun = false } = opts;
  const rows = db.query('SELECT id, last_line_offset FROM session_store').all() as Array<{
    id: string;
    last_line_offset: number | null;
  }>;

  const report: RecoveryReport = {
    scanned: rows.length,
    inSync: 0,
    drifted: 0,
    missingJsonl: 0,
    perSession: [],
  };

  const rebuilder = new IndexRebuilder(db, layout);

  for (const row of rows) {
    const files = sessionFiles(layout, row.id);
    if (!existsSync(files.events)) {
      report.missingJsonl += 1;
      report.perSession.push({
        sessionId: row.id,
        status: 'missing-jsonl',
        expectedOffset: row.last_line_offset,
        actualSize: null,
      });
      continue;
    }
    const actualSize = statSync(files.events).size;
    const expectedOffset = row.last_line_offset ?? 0;
    if (actualSize === expectedOffset) {
      report.inSync += 1;
      report.perSession.push({
        sessionId: row.id,
        status: 'in-sync',
        expectedOffset,
        actualSize,
      });
      continue;
    }
    if (!dryRun) {
      rebuilder.rebuildSessionIndex(row.id);
    }
    report.drifted += 1;
    report.perSession.push({
      sessionId: row.id,
      status: 'drifted',
      expectedOffset,
      actualSize,
    });
  }

  return report;
}
