/**
 * Phase 5 — session tombstones.
 *
 * Completes the `session.hardDelete.policy` config flag introduced in
 * Phase 2. With `policy=tombstone` (default), `SessionManager.hardDelete`
 * moves the session subdir to `<sessionsDir>/.tombstones/<id>-<purgedAt>/`
 * after the SQLite row is deleted. The JSONL audit chain is preserved
 * on disk (I16) but no longer drives any user-facing surface.
 *
 * Operators reclaim disk space via `vinyan session tombstone gc
 * [--older-than=90d] [--dry-run]` — a separate, explicitly-invoked
 * operation. The retention window comes from
 * `session.tombstone.retentionDays` config (Phase 5.5 for default
 * wiring; Phase 5 ships the CLI knob).
 *
 * `policy=purge` (operator opt-in) skips tombstone and deletes the
 * subdir outright, the GDPR-style "right to forget" path.
 */
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionDirLayout } from './paths.ts';

export const TOMBSTONE_DIR_NAME = '.tombstones';

export type HardDeletePolicy = 'tombstone' | 'purge';

/** Resolve the absolute path of the tombstones directory. */
export function tombstonesDir(layout: SessionDirLayout): string {
  return join(layout.sessionsDir, TOMBSTONE_DIR_NAME);
}

/**
 * Move `<sessionsDir>/<sessionId>/` to `<sessionsDir>/.tombstones/<id>-<purgedAt>/`.
 * No-op when the source dir does not exist (e.g. session was created
 * before Phase 2 dual-write so it has no JSONL files). Returns the
 * destination path on a successful move, `null` otherwise.
 *
 * `purgedAt` is part of the destination name so a session purged
 * twice (impossible today, but defensive) does not collide on the
 * filesystem.
 */
export function moveToTombstone(layout: SessionDirLayout, sessionId: string, purgedAt: number): string | null {
  const src = join(layout.sessionsDir, sessionId);
  if (!existsSync(src)) return null;
  const tombDir = tombstonesDir(layout);
  mkdirSync(tombDir, { recursive: true });
  const dest = join(tombDir, `${sessionId}-${purgedAt}`);
  renameSync(src, dest);
  return dest;
}

/**
 * Hard-delete a session subdir outright. Used when the operator has
 * opted into `policy=purge` — JSONL audit chain is destroyed (the
 * GDPR-style "right to forget" trade-off).
 */
export function purgeSessionDir(layout: SessionDirLayout, sessionId: string): boolean {
  const src = join(layout.sessionsDir, sessionId);
  if (!existsSync(src)) return false;
  rmSync(src, { recursive: true, force: true });
  return true;
}

export interface TombstoneGcOptions {
  /** Tombstones whose dir mtime is older than this many ms get pruned. */
  olderThanMs: number;
  /** When true, count what would be deleted but don't touch the fs. */
  dryRun?: boolean;
}

export interface TombstoneGcReport {
  scanned: number;
  pruned: number;
  retained: number;
  prunedIds: string[];
}

/**
 * Walk `<sessionsDir>/.tombstones/` and prune entries older than
 * `olderThanMs` (relative to mtime). Phase 5 default retention is
 * 90 days; the caller supplies the value.
 */
export function tombstoneGc(layout: SessionDirLayout, opts: TombstoneGcOptions): TombstoneGcReport {
  const dir = tombstonesDir(layout);
  const report: TombstoneGcReport = { scanned: 0, pruned: 0, retained: 0, prunedIds: [] };
  if (!existsSync(dir)) return report;

  const cutoff = Date.now() - opts.olderThanMs;
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    report.scanned += 1;
    const subdir = join(dir, entry.name);
    let mtime: number;
    try {
      mtime = statSync(subdir).mtimeMs;
    } catch {
      // Couldn't stat — best-effort skip.
      report.retained += 1;
      continue;
    }
    if (mtime < cutoff) {
      if (!opts.dryRun) rmSync(subdir, { recursive: true, force: true });
      report.pruned += 1;
      report.prunedIds.push(entry.name);
    } else {
      report.retained += 1;
    }
  }
  return report;
}
