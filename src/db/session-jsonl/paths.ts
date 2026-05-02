/**
 * Path resolver for per-session JSONL storage.
 *
 * Layout (Phase 1+ — segments and snapshot are Phase 5):
 *   <sessionsDir>/<sessionId>/
 *     events.jsonl         active append-only segment
 *     events.NNNN.jsonl    rotated segment (Phase 5)
 *     segments.json        manifest (Phase 5)
 *     snapshot.json        derived state cache (Phase 5)
 *     index.lock           cross-process advisory lock
 *
 * `sessionsDir` is the resolved profile-aware path from
 * `src/config/profile-resolver.ts` — typically
 * `~/.vinyan/profiles/<profile>/sessions/`.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface SessionDirLayout {
  sessionsDir: string;
}

export interface SessionFiles {
  /** Per-session subdirectory. */
  dir: string;
  /** Active append-only events log. */
  events: string;
  /** Cross-process advisory lock file. */
  lock: string;
  /** Optional snapshot sidecar (Phase 5). */
  snapshot: string;
  /** Optional segment manifest (Phase 5). */
  segments: string;
}

/** Reject ids that could escape the sessions dir. */
const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertValidSessionId(id: string): void {
  if (!SESSION_ID_RE.test(id)) {
    throw new Error(`session-jsonl: invalid sessionId ${JSON.stringify(id)}`);
  }
}

export function sessionFiles(layout: SessionDirLayout, sessionId: string): SessionFiles {
  assertValidSessionId(sessionId);
  const dir = join(layout.sessionsDir, sessionId);
  return {
    dir,
    events: join(dir, 'events.jsonl'),
    lock: join(dir, 'index.lock'),
    snapshot: join(dir, 'snapshot.json'),
    segments: join(dir, 'segments.json'),
  };
}

/** Create the per-session dir if missing; idempotent. */
export function ensureSessionDir(layout: SessionDirLayout, sessionId: string): SessionFiles {
  const files = sessionFiles(layout, sessionId);
  mkdirSync(files.dir, { recursive: true });
  return files;
}
