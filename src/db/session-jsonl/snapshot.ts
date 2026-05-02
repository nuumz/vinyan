/**
 * Phase 5 — `snapshot.json` sidecar.
 *
 * The snapshot is a **fast-resume cache**, not a source of truth.
 * Loading a session from `snapshot.json` lets the dashboard surface
 * recent state without replaying the full JSONL log; if the snapshot
 * is missing or corrupt, callers must fall back to JSONL replay
 * (`JsonlReader.scan`) — that's the I16 audit trail.
 *
 * Phase 5 ships an explicit `writeSnapshot` / `readSnapshot` API.
 * Auto-debouncing (write after 30s of inactivity, or after
 * `session.compacted`) is left to a follow-up — the API is stable
 * enough that adding a debounced caller later is a one-file change.
 *
 * Atomicity: snapshot.json is rewritten atomically (temp + rename).
 * A crash mid-write leaves either the previous file or the new one,
 * never a half-written sidecar.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type SessionDirLayout, sessionFiles } from './paths.ts';

/** On-disk shape of `<sessionDir>/snapshot.json`. */
export interface SessionSnapshot {
  version: 1;
  /** Epoch-ms when the snapshot was written. */
  generatedAt: number;
  /** lineId of the most recent JSONL line covered by the snapshot. */
  lastLineId: string | null;
  /** Byte offset within the active segment AT snapshot time. */
  lastLineOffset: number;
  /** Active segment filename when the snapshot was written. */
  activeSegment: string;
  /** Materialized state. Caller decides what to include. */
  state: unknown;
}

function atomicWrite(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const stamp = createHash('sha256').update(`${path}|${Date.now()}|${Math.random()}`).digest('hex').slice(0, 16);
  const tempPath = join(dir, `.${stamp}.tmp`);
  writeFileSync(tempPath, content, { encoding: 'utf-8', flag: 'wx' });
  renameSync(tempPath, path);
}

/** Write `snapshot.json` atomically. Caller supplies the full state. */
export function writeSnapshot(
  layout: SessionDirLayout,
  sessionId: string,
  payload: Omit<SessionSnapshot, 'version'>,
): void {
  const files = sessionFiles(layout, sessionId);
  const snapshot: SessionSnapshot = { version: 1, ...payload };
  atomicWrite(files.snapshot, JSON.stringify(snapshot, null, 2));
}

/**
 * Read `snapshot.json` if present and well-formed. Returns `null` on
 * miss / parse failure — callers must fall back to JSONL replay.
 */
export function readSnapshot(layout: SessionDirLayout, sessionId: string): SessionSnapshot | null {
  const files = sessionFiles(layout, sessionId);
  if (!existsSync(files.snapshot)) return null;
  try {
    const raw = readFileSync(files.snapshot, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<SessionSnapshot>;
    if (
      parsed &&
      typeof parsed === 'object' &&
      parsed.version === 1 &&
      typeof parsed.generatedAt === 'number' &&
      typeof parsed.lastLineOffset === 'number' &&
      typeof parsed.activeSegment === 'string' &&
      'state' in parsed
    ) {
      return parsed as SessionSnapshot;
    }
  } catch {
    // corrupt snapshot — caller falls back to JSONL replay
  }
  return null;
}

/**
 * Determine whether a snapshot's view of the session matches what's
 * currently on disk. Used by the recovery scan to decide whether the
 * snapshot can be trusted as a resume point. Returns false if the
 * active segment moved past the snapshot (new lines have been written
 * since), or if the snapshot's active segment no longer matches the
 * current one (rotation has happened past it).
 */
export function snapshotIsCurrent(
  snapshot: SessionSnapshot,
  current: { activeSegment: string; activeSize: number },
): boolean {
  if (snapshot.activeSegment !== current.activeSegment) return false;
  return snapshot.lastLineOffset === current.activeSize;
}
