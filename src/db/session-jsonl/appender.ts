/**
 * JsonlAppender — writes per-session JSONL lines as the source of truth
 * for session state.
 *
 * Phase 1 deliverable: the appender is fully functional but dormant —
 * `SessionManager` is wired to it only in Phase 2. Tests in
 * `tests/db/session-jsonl/appender.test.ts` exercise it in isolation.
 *
 * Concurrency: per-session async mutex (`mutex.ts`) serializes appends
 * within a process. Cross-process locking is deferred to Phase 5
 * (`flock(LOCK_EX)` on `<sessionDir>/index.lock`); Phase 1 assumes a
 * single Vinyan process. The mutex also makes `seq` allocation race-
 * free, replacing the implicit single-writer contract that today's
 * `MAX(seq)+1` query in `src/db/session-store.ts:660` relies on.
 *
 * Crash safety: write line + `\n` → fsync (per policy) → update cursor.
 * If the process dies after `write` but before `fsync`, the OS may
 * still flush — and any partial trailing bytes are detected and
 * skipped by `JsonlReader`. Cursors are scanned from the file on first
 * append per session, so a lost in-memory state is reconstructible.
 */

import { randomUUID } from 'node:crypto';
import { closeSync, fstatSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs';
import { type FsyncPolicy, makeFsyncPolicy } from './fsync-policy.ts';
import { KeyedMutex } from './mutex.ts';
import { ensureSessionDir, type SessionDirLayout } from './paths.ts';
import { type AppendInput, JSONL_SCHEMA_VERSION, type JsonlLine, JsonlLineZ } from './schemas.ts';
import { DEFAULT_MAX_SEGMENT_BYTES, sealActiveSegment } from './segments.ts';

export interface JsonlAppenderOptions {
  layout: SessionDirLayout;
  policy?: FsyncPolicy;
  /** Override clock for tests. */
  now?: () => number;
  /** Override line id factory for tests. */
  newId?: () => string;
  /**
   * Phase 5 — when the active `events.jsonl` exceeds this size in
   * bytes after a write, the appender atomically seals it as
   * `events.NNNN.jsonl` and starts a new active segment. Default
   * 64 MB; lower bound makes tests deterministic without 64 MB of
   * payload.
   */
  maxBytesPerSegment?: number;
}

/** Cached per-session write cursor. */
interface Cursor {
  /** Next seq to allocate. */
  seq: number;
  /** lineId of the most recently written line, or null when the file is empty. */
  lastLineId: string | null;
  /** Byte size of the events file after the last write. */
  byteOffset: number;
  /**
   * Phase 5 — the lineId / seq of the first line written to the
   * **active** segment. Captured at segment open and copied into the
   * sealed entry on rotation.
   */
  segmentFirstLineId: string | null;
  segmentFirstSeq: number;
}

export interface AppendResult {
  line: JsonlLine;
  /** Byte offset where this line starts in the events file. */
  byteOffset: number;
  /** Length of the line bytes including the trailing newline. */
  byteLength: number;
}

export class JsonlAppender {
  private readonly mutex = new KeyedMutex();
  private readonly cursors = new Map<string, Cursor>();
  private readonly policy: FsyncPolicy;
  private readonly clock: () => number;
  private readonly newId: () => string;
  private readonly maxBytesPerSegment: number;

  constructor(private readonly opts: JsonlAppenderOptions) {
    this.policy = opts.policy ?? makeFsyncPolicy();
    this.clock = opts.now ?? Date.now;
    this.newId = opts.newId ?? randomUUID;
    this.maxBytesPerSegment = opts.maxBytesPerSegment ?? DEFAULT_MAX_SEGMENT_BYTES;
  }

  /**
   * Async append — acquires the per-session mutex before calling
   * `appendSync`. Use this from any async code path that may have
   * concurrent writers within the process.
   */
  async append(sessionId: string, input: AppendInput): Promise<AppendResult> {
    return this.mutex.run(sessionId, () => Promise.resolve(this.appendSync(sessionId, input)));
  }

  /**
   * Synchronous append. Public so SessionManager (which today calls
   * SessionStore synchronously and is invoked by sync orchestrator
   * pathways) can dual-write JSONL without async-cascading every caller
   * (chat.ts, server.ts have ~10 call sites). Relies on the existing
   * single-writer-per-session contract — the same one `MAX(seq)+1` in
   * `session-store.ts:660` already assumes. Add `await append(...)` /
   * mutex when concurrent writers per session become real (Phase 6+).
   */
  appendSync(sessionId: string, input: AppendInput): AppendResult {
    const files = ensureSessionDir(this.opts.layout, sessionId);
    const cursor = this.loadCursor(sessionId, files.events);

    const line: JsonlLine = {
      v: JSONL_SCHEMA_VERSION,
      lineId: this.newId(),
      parentLineId: input.parentLineId === undefined ? cursor.lastLineId : input.parentLineId,
      sessionId,
      seq: cursor.seq,
      ts: this.clock(),
      actor: input.actor,
      kind: input.kind,
      payload: input.payload,
    };

    JsonlLineZ.parse(line);

    const serialized = `${JSON.stringify(line)}\n`;
    const bytes = Buffer.from(serialized, 'utf-8');
    const startOffset = cursor.byteOffset;

    const fd = openSync(files.events, 'a');
    try {
      writeSync(fd, bytes);
      if (this.policy.shouldFsync(input.kind)) {
        fsyncSync(fd);
      }
      const stat = fstatSync(fd);
      cursor.seq = line.seq + 1;
      cursor.lastLineId = line.lineId;
      cursor.byteOffset = stat.size;
      // Capture segment-first metadata if this is the first write to a
      // fresh active segment.
      if (cursor.segmentFirstLineId === null) {
        cursor.segmentFirstLineId = line.lineId;
        cursor.segmentFirstSeq = line.seq;
      }
    } finally {
      closeSync(fd);
    }

    const result: AppendResult = { line, byteOffset: startOffset, byteLength: bytes.length };

    // Phase 5 rotation: post-write threshold check. If the active
    // segment now exceeds the cap, atomically seal it. The line just
    // written sits in the sealed segment; the next appendSync starts
    // a fresh `events.jsonl`.
    if (cursor.byteOffset >= this.maxBytesPerSegment) {
      this.rotateActiveSegment(sessionId, cursor);
    }

    return result;
  }

  private rotateActiveSegment(sessionId: string, cursor: Cursor): void {
    if (cursor.segmentFirstLineId === null || cursor.lastLineId === null) {
      // Nothing was written to the active segment yet — nothing to seal.
      return;
    }
    sealActiveSegment(this.opts.layout, sessionId, {
      firstLineId: cursor.segmentFirstLineId,
      firstSeq: cursor.segmentFirstSeq,
      lastLineId: cursor.lastLineId,
      lastSeq: cursor.seq - 1,
      activeSize: cursor.byteOffset,
      sealedAt: this.clock(),
    });
    // Active segment is now empty (file renamed away). Reset cursor's
    // segment-tracking fields. seq + lastLineId stay — they're per-
    // session, not per-segment.
    cursor.byteOffset = 0;
    cursor.segmentFirstLineId = null;
    cursor.segmentFirstSeq = cursor.seq;
  }

  /**
   * Load (or hydrate) the per-session cursor. On first access we scan
   * the existing events.jsonl to recover `seq`, `lastLineId`, and
   * byte size — ensures correct continuation across process restarts.
   *
   * The scan tolerates a partial trailing line (no terminating `\n`)
   * by ignoring it; the next write appends after the last good newline
   * so the partial bytes are eventually overwritten only if a future
   * truncate path opts in. Phase 1 never truncates.
   */
  private loadCursor(sessionId: string, eventsPath: string): Cursor {
    const cached = this.cursors.get(sessionId);
    if (cached) return cached;

    let cursor: Cursor = {
      seq: 0,
      lastLineId: null,
      byteOffset: 0,
      segmentFirstLineId: null,
      segmentFirstSeq: 0,
    };
    try {
      const raw = readFileSync(eventsPath, 'utf-8');
      if (raw.length > 0) {
        const lastNewline = raw.lastIndexOf('\n');
        const ending = lastNewline === -1 ? raw : raw.slice(0, lastNewline);
        const lines = ending.length === 0 ? [] : ending.split('\n');
        // Forward scan: capture firstLineId/firstSeq of the active
        // segment so a later rotation seals the full range correctly.
        let firstLineId: string | null = null;
        let firstSeq = 0;
        for (const candidate of lines) {
          if (!candidate) continue;
          try {
            const parsed = JsonlLineZ.parse(JSON.parse(candidate));
            firstLineId = parsed.lineId;
            firstSeq = parsed.seq;
            break;
          } catch {
            // Skip and try the next line — a malformed leading line
            // shouldn't tank hydration (A9).
          }
        }
        for (let i = lines.length - 1; i >= 0; i--) {
          const candidate = lines[i];
          if (!candidate) continue;
          try {
            const parsed = JsonlLineZ.parse(JSON.parse(candidate));
            cursor = {
              seq: parsed.seq + 1,
              lastLineId: parsed.lineId,
              byteOffset: lastNewline === -1 ? raw.length : lastNewline + 1,
              segmentFirstLineId: firstLineId,
              segmentFirstSeq: firstSeq,
            };
            // Trailing partial line (no \n) is left in place; cursor.byteOffset
            // skips past the last good newline so the next append starts on a
            // fresh line. The partial bytes between byteOffset and EOF will be
            // detected by the reader and reported as a parse error per A9.
            break;
          } catch {
            // Malformed line — keep walking back. This is the "tolerate
            // forensic noise" branch (A9); a rebuild via IndexRebuilder
            // can still recover authoritative state.
          }
        }
      }
    } catch (err) {
      // ENOENT is the common case — fresh session — and we already start
      // from zero. Anything else propagates so the caller sees the IO error.
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    this.cursors.set(sessionId, cursor);
    return cursor;
  }

  /** For tests: clear the in-process cursor cache. */
  resetCacheForTests(): void {
    this.cursors.clear();
  }
}
