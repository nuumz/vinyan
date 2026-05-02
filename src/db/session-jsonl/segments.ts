/**
 * Phase 5 — JSONL segment rotation.
 *
 * Layout (post-Phase-5):
 *   <sessionsDir>/<sessionId>/
 *     events.jsonl              # active segment, append-only
 *     events.0000.jsonl         # sealed segment (oldest)
 *     events.0001.jsonl         # sealed segment
 *     ...
 *     segments.json             # manifest of sealed segments
 *
 * **Active segment is always called `events.jsonl`** (Option A naming).
 * Rotation = atomic rename to the next sealed name + create a fresh
 * `events.jsonl`. Backward compatible: sessions without `segments.json`
 * are read as single-file (legacy Phase 1-4 layout).
 *
 * Rotation timing: post-write. After each appendSync, if the active
 * segment's size has crossed `maxBytesPerSegment`, the writer seals
 * the current file and opens a new one. The line that triggered
 * rotation lives in the sealed segment.
 *
 * Atomicity: `renameSync` is atomic on POSIX; the manifest is written
 * via `vault.atomicWrite` (temp file + rename). Crash mid-rotation
 * leaves either: (a) sealed file present + manifest stale → recovery
 * heals it, or (b) sealed file present + manifest updated + active
 * file missing → next appendSync creates it on demand.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type SessionDirLayout, type SessionFiles, sessionFiles } from './paths.ts';

/**
 * Atomic file replace via temp + rename. Mirrors the pattern in
 * `src/memory/wiki/vault.ts:118` but inlined here to keep
 * session-jsonl self-contained (no cross-module coupling for a
 * 7-line helper).
 */
function atomicWrite(path: string, content: string): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const stamp = createHash('sha256').update(`${path}|${Date.now()}|${Math.random()}`).digest('hex').slice(0, 16);
  const tempPath = join(dir, `.${stamp}.tmp`);
  writeFileSync(tempPath, content, { encoding: 'utf-8', flag: 'wx' });
  renameSync(tempPath, path);
}

/** Default rotation threshold — 64 MB per segment. */
export const DEFAULT_MAX_SEGMENT_BYTES = 64 * 1024 * 1024;

export interface SegmentEntry {
  /** Filename relative to the session subdir, e.g. `events.0000.jsonl`. */
  name: string;
  /** Size in bytes at seal time. */
  size: number;
  /** lineId of the first line in this segment. */
  firstLineId: string;
  /** lineId of the last line in this segment. */
  lastLineId: string;
  /** seq of the first line. */
  firstSeq: number;
  /** seq of the last line. */
  lastSeq: number;
  /** Epoch-ms when the segment was sealed. */
  sealedAt: number;
}

export interface SegmentManifest {
  version: 1;
  /** Sealed segments in seal order (oldest first). */
  sealed: SegmentEntry[];
}

/** Read the manifest if present; otherwise return an empty manifest. */
export function readManifest(layout: SessionDirLayout, sessionId: string): SegmentManifest {
  const files = sessionFiles(layout, sessionId);
  if (!existsSync(files.segments)) {
    return { version: 1, sealed: [] };
  }
  try {
    const raw = readFileSync(files.segments, 'utf-8');
    const parsed = JSON.parse(raw) as SegmentManifest;
    // Defensive: tolerate older shapes by clamping to known fields.
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.sealed)) {
      return { version: 1, sealed: parsed.sealed };
    }
  } catch {
    // Corrupt manifest — treat as no rotation history. Recovery can rebuild.
  }
  return { version: 1, sealed: [] };
}

/** Atomic-rewrite of the manifest. */
export function writeManifest(layout: SessionDirLayout, sessionId: string, manifest: SegmentManifest): void {
  const files = sessionFiles(layout, sessionId);
  atomicWrite(files.segments, JSON.stringify(manifest, null, 2));
}

/** Allocate the filename for the next sealed segment based on current count. */
export function nextSealedSegmentName(manifest: SegmentManifest): string {
  const next = manifest.sealed.length;
  return `events.${next.toString().padStart(4, '0')}.jsonl`;
}

/**
 * In-order list of every segment file path that contributes to this
 * session's history — sealed segments first (oldest → newest), then
 * the active `events.jsonl` if it exists. Used by `JsonlReader.scan`
 * and `IndexRebuilder` to walk the full history without missing
 * pre-rotation lines.
 */
export function orderedSegmentPaths(layout: SessionDirLayout, sessionId: string): string[] {
  const files = sessionFiles(layout, sessionId);
  const manifest = readManifest(layout, sessionId);
  const paths: string[] = [];
  for (const sealed of manifest.sealed) {
    paths.push(join(files.dir, sealed.name));
  }
  if (existsSync(files.events)) paths.push(files.events);
  return paths;
}

export interface RotationContext {
  /** First line written to the active segment (sealed-soon). */
  firstLineId: string;
  /** seq of that first line. */
  firstSeq: number;
  /** Latest line written before rotation triggered. */
  lastLineId: string;
  lastSeq: number;
  /** Size of active segment at rotation trigger. */
  activeSize: number;
  /** Epoch-ms of the seal. */
  sealedAt: number;
}

/**
 * Seal the current `events.jsonl` as `events.NNNN.jsonl` and atomically
 * append to the manifest. Caller must have just finished a write that
 * pushed the active segment over the size threshold AND must hold the
 * per-session lock for the duration.
 *
 * Side effects:
 *   - rename `events.jsonl` → `events.NNNN.jsonl`
 *   - rewrite `segments.json` with the new entry
 *   - the next `appendSync` creates a fresh empty `events.jsonl`
 *
 * Returns the manifest after sealing — caller can stash it as a cache
 * to avoid re-reading on the next rotation.
 */
export function sealActiveSegment(layout: SessionDirLayout, sessionId: string, ctx: RotationContext): SegmentManifest {
  const files: SessionFiles = sessionFiles(layout, sessionId);
  const manifest = readManifest(layout, sessionId);
  const sealedName = nextSealedSegmentName(manifest);
  const sealedPath = join(files.dir, sealedName);
  renameSync(files.events, sealedPath);
  manifest.sealed.push({
    name: sealedName,
    size: ctx.activeSize,
    firstLineId: ctx.firstLineId,
    firstSeq: ctx.firstSeq,
    lastLineId: ctx.lastLineId,
    lastSeq: ctx.lastSeq,
    sealedAt: ctx.sealedAt,
  });
  writeManifest(layout, sessionId, manifest);
  return manifest;
}
