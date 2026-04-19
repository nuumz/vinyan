/**
 * sqlite-vec extension loader (plan commit E).
 *
 * Loads the `sqlite-vec` shared library into a `bun:sqlite` Database so the
 * `vec0` virtual table and `vec_distance_cosine` function become available.
 *
 * Design:
 *   - Best-effort: returns true on success, false when the extension is
 *     absent. Never throws — callers use the return value to decide whether
 *     to expose semantic retrieval.
 *   - Safe to call multiple times: extension registration is idempotent at
 *     the SQLite level.
 *   - Environment control: `VINYAN_DISABLE_SQLITE_VEC=1` forces a no-op,
 *     useful in CI / tests where loading the native extension isn't wanted.
 *
 * Usage:
 *
 *   import { loadSqliteVec } from '../memory/sqlite-vec-loader.ts';
 *   const db = new Database(path);
 *   const ok = loadSqliteVec(db);
 *   if (!ok) { /* semantic retrieval disabled; retriever falls back to recency *\/ }
 */
import type { Database } from 'bun:sqlite';

export interface SqliteVecLoadResult {
  loaded: boolean;
  version?: string;
  reason?: string;
}

/**
 * Attempt to load sqlite-vec into the supplied Database connection.
 * Returns a result object describing what happened (for logging / tests).
 */
export function loadSqliteVec(db: Database): SqliteVecLoadResult {
  if (process.env.VINYAN_DISABLE_SQLITE_VEC === '1') {
    return { loaded: false, reason: 'disabled-by-env' };
  }

  // Already loaded? Probe vec_version().
  try {
    const row = db.query('SELECT vec_version() AS version').get() as
      | { version: string }
      | undefined;
    if (row?.version) {
      return { loaded: true, version: row.version };
    }
  } catch {
    // Not loaded yet — fall through to load attempt.
  }

  // Dynamic require so the module dependency is optional. When `sqlite-vec`
  // isn't installed, we degrade gracefully without dragging users into a
  // compile-time failure.
  let vecModule: unknown;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    vecModule = require('sqlite-vec');
  } catch (err) {
    return { loaded: false, reason: `module-load-failed: ${String(err).slice(0, 120)}` };
  }

  const load = (vecModule as { load?: (db: Database) => void }).load;
  if (typeof load !== 'function') {
    return { loaded: false, reason: 'sqlite-vec module missing load()' };
  }

  try {
    load(db);
  } catch (err) {
    return { loaded: false, reason: `extension-load-failed: ${String(err).slice(0, 120)}` };
  }

  try {
    const row = db.query('SELECT vec_version() AS version').get() as
      | { version: string }
      | undefined;
    return { loaded: true, version: row?.version ?? 'unknown' };
  } catch (err) {
    return { loaded: false, reason: `post-load-probe-failed: ${String(err).slice(0, 120)}` };
  }
}

/**
 * Convenience: load + warn once. Returns the same result object but prints
 * a single stderr warning on failure so the caller doesn't need to plumb.
 */
export function loadSqliteVecWithWarn(db: Database, context = 'vinyan'): SqliteVecLoadResult {
  const result = loadSqliteVec(db);
  if (!result.loaded && result.reason !== 'disabled-by-env') {
    console.warn(
      `[${context}] sqlite-vec unavailable — semantic retrieval disabled (${result.reason})`,
    );
  }
  return result;
}
