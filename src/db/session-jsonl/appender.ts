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

export interface JsonlAppenderOptions {
  layout: SessionDirLayout;
  policy?: FsyncPolicy;
  /** Override clock for tests. */
  now?: () => number;
  /** Override line id factory for tests. */
  newId?: () => string;
}

/** Cached per-session write cursor. */
interface Cursor {
  /** Next seq to allocate. */
  seq: number;
  /** lineId of the most recently written line, or null when the file is empty. */
  lastLineId: string | null;
  /** Byte size of the events file after the last write. */
  byteOffset: number;
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

  constructor(private readonly opts: JsonlAppenderOptions) {
    this.policy = opts.policy ?? makeFsyncPolicy();
    this.clock = opts.now ?? Date.now;
    this.newId = opts.newId ?? randomUUID;
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
    } finally {
      closeSync(fd);
    }

    return { line, byteOffset: startOffset, byteLength: bytes.length };
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

    let cursor: Cursor = { seq: 0, lastLineId: null, byteOffset: 0 };
    try {
      const raw = readFileSync(eventsPath, 'utf-8');
      if (raw.length > 0) {
        const lastNewline = raw.lastIndexOf('\n');
        const ending = lastNewline === -1 ? raw : raw.slice(0, lastNewline);
        const lines = ending.length === 0 ? [] : ending.split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
          const candidate = lines[i];
          if (!candidate) continue;
          try {
            const parsed = JsonlLineZ.parse(JSON.parse(candidate));
            cursor = {
              seq: parsed.seq + 1,
              lastLineId: parsed.lineId,
              byteOffset: lastNewline === -1 ? raw.length : lastNewline + 1,
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
