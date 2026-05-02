/**
 * JsonlReader — read-side of the per-session JSONL store.
 *
 * Phase 1 surface: streaming `scan`, full `replay`, bounded `tailLines`.
 * Phase 5 will add segment-aware iteration; for Phase 1 the reader
 * walks a single `events.jsonl` per session.
 *
 * Resilience: a malformed line is reported via `onError` (or returned
 * in the error array for `tailLines`/`replay`) but never throws —
 * matches A9 (resilient degradation). The `IndexRebuilder` uses the
 * same resilience contract to make rebuilds idempotent under
 * partially-corrupt logs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { type SessionDirLayout, sessionFiles } from './paths.ts';
import { type JsonlLine, type JsonlLineError, JsonlLineZ } from './schemas.ts';
import { orderedSegmentPaths } from './segments.ts';

export interface ScannedLine {
  line: JsonlLine;
  /** 0-based byte offset of the line's first byte in the segment file. */
  byteOffset: number;
  /** Byte length of the line excluding the trailing newline. */
  byteLength: number;
}

export interface ScanResult {
  lines: ScannedLine[];
  errors: JsonlLineError[];
  /** Byte offset of the next free position (size of the events file in bytes). */
  endOffset: number;
}

export class JsonlReader {
  constructor(private readonly layout: SessionDirLayout) {}

  /**
   * Stream every line of the session, in append order. Phase 5:
   * iterates sealed segments first (oldest → newest) then the active
   * `events.jsonl` if present. Backward-compatible — sessions without
   * a `segments.json` manifest read as a single `events.jsonl`.
   *
   * `byteOffset` is **within the current segment file** — not a
   * global offset across all segments. The recovery scan + cursor
   * tracking only ever cares about the active segment, so a per-file
   * offset is the natural unit.
   */
  *scan(sessionId: string): Generator<ScannedLine | { error: JsonlLineError }, void, void> {
    // Resolve the in-order path list (sealed + active). Empty when the
    // session has never been written to (file does not exist).
    const paths = orderedSegmentPaths(this.layout, sessionId);
    if (paths.length === 0) {
      // Backward-compat probe — older code referred to `files.events`
      // directly. orderedSegmentPaths already covers that case.
      return;
    }
    for (const path of paths) {
      yield* this.scanFile(sessionId, path);
    }
  }

  /** Yield every line from a single segment file. */
  private *scanFile(sessionId: string, path: string): Generator<ScannedLine | { error: JsonlLineError }, void, void> {
    if (!existsSync(path)) return;
    const raw = readFileSync(path, 'utf-8');
    const buf = Buffer.from(raw, 'utf-8');
    let cursor = 0;
    const total = buf.length;
    while (cursor < total) {
      const newline = buf.indexOf(0x0a /* \n */, cursor);
      if (newline === -1) {
        const partial = buf.slice(cursor).toString('utf-8');
        if (partial.length > 0) {
          yield {
            error: {
              sessionId,
              byteOffset: cursor,
              byteLength: partial.length,
              raw: partial,
              reason: 'partial line: no terminating newline',
            },
          };
        }
        break;
      }
      const lineBytes = buf.slice(cursor, newline);
      const text = lineBytes.toString('utf-8');
      try {
        const parsed = JsonlLineZ.parse(JSON.parse(text));
        yield { line: parsed, byteOffset: cursor, byteLength: lineBytes.length };
      } catch (err) {
        yield {
          error: {
            sessionId,
            byteOffset: cursor,
            byteLength: lineBytes.length,
            raw: text,
            reason: err instanceof Error ? err.message : String(err),
          },
        };
      }
      cursor = newline + 1;
    }
  }

  /** Materialize every line + error in a single pass. */
  scanAll(sessionId: string): ScanResult {
    const lines: ScannedLine[] = [];
    const errors: JsonlLineError[] = [];
    let endOffset = 0;
    for (const item of this.scan(sessionId)) {
      if ('error' in item) {
        errors.push(item.error);
        endOffset = item.error.byteOffset + item.error.byteLength;
      } else {
        lines.push(item);
        endOffset = item.byteOffset + item.byteLength + 1; // +1 for \n
      }
    }
    return { lines, errors, endOffset };
  }

  /** Newest `n` lines, in append order. Loads the whole segment for now. */
  tailLines(sessionId: string, n: number): ScannedLine[] {
    if (n <= 0) return [];
    const all = this.scanAll(sessionId).lines;
    return all.slice(Math.max(0, all.length - n));
  }

  /**
   * Find the line with the given `lineId`, scanning from the start.
   * Returns `undefined` if not found. Phase 5 will add an offset hint
   * so callers can skip already-known prefixes.
   */
  seekByLineId(sessionId: string, lineId: string): ScannedLine | undefined {
    for (const item of this.scan(sessionId)) {
      if ('error' in item) continue;
      if (item.line.lineId === lineId) return item;
    }
    return undefined;
  }
}
