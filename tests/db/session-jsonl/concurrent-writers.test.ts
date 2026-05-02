/**
 * JsonlAppender — concurrent writer race tests.
 *
 * Phase 1 invariant: per-session mutex serializes appends so that
 *   (a) seq is monotonic with no gaps,
 *   (b) parentLineId chain is unbroken,
 *   (c) lines from different sessions never interleave within a single
 *       events.jsonl.
 *
 * If the mutex regresses, one of these assertions fails. This is the
 * primary defense against the `MAX(seq)+1` race the plan calls out.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlAppender } from '../../../src/db/session-jsonl/appender.ts';
import { makeFsyncPolicy } from '../../../src/db/session-jsonl/fsync-policy.ts';
import { JsonlReader } from '../../../src/db/session-jsonl/reader.ts';

function makeLayout(): { sessionsDir: string } {
  return { sessionsDir: mkdtempSync(join(tmpdir(), 'vinyan-concurrent-')) };
}

describe('JsonlAppender — concurrency', () => {
  test('serializes 100 concurrent appends per session — seq is gapless and chain is unbroken', async () => {
    const layout = makeLayout();
    const appender = new JsonlAppender({
      layout,
      policy: makeFsyncPolicy('none'),
    });

    const sessionId = 'sess-race';
    const tasks: Promise<unknown>[] = [];
    for (let i = 0; i < 100; i++) {
      tasks.push(
        appender.append(sessionId, {
          kind: 'turn.appended',
          payload: { turnId: `t${i}`, role: 'user', blocks: [] },
          actor: { kind: 'user' },
        }),
      );
    }
    await Promise.all(tasks);

    const reader = new JsonlReader(layout);
    const { lines, errors } = reader.scanAll(sessionId);
    expect(errors).toEqual([]);
    expect(lines).toHaveLength(100);

    let prevId: string | null = null;
    for (let i = 0; i < lines.length; i++) {
      expect(lines[i]?.line.seq).toBe(i);
      expect(lines[i]?.line.parentLineId).toBe(prevId);
      prevId = lines[i]?.line.lineId ?? null;
    }
  });

  test('appends to two sessions in parallel — no interleaving in either file', async () => {
    const layout = makeLayout();
    const appender = new JsonlAppender({
      layout,
      policy: makeFsyncPolicy('none'),
    });

    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 30; i++) {
      promises.push(
        appender.append('sess-A', {
          kind: 'turn.appended',
          payload: { turnId: `a${i}`, role: 'user', blocks: [] },
          actor: { kind: 'user' },
        }),
      );
      promises.push(
        appender.append('sess-B', {
          kind: 'turn.appended',
          payload: { turnId: `b${i}`, role: 'user', blocks: [] },
          actor: { kind: 'user' },
        }),
      );
    }
    await Promise.all(promises);

    const reader = new JsonlReader(layout);
    for (const sessionId of ['sess-A', 'sess-B']) {
      const { lines, errors } = reader.scanAll(sessionId);
      expect(errors).toEqual([]);
      expect(lines).toHaveLength(30);
      // Every line in sess-A's file must have sessionId 'sess-A' and vice versa.
      expect(lines.every((l) => l.line.sessionId === sessionId)).toBe(true);
      // seq is gapless 0..29.
      expect(lines.map((l) => l.line.seq)).toEqual(Array.from({ length: 30 }, (_, i) => i));
    }
  });
});
