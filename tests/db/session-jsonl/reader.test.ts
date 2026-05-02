/**
 * JsonlReader — Phase 1 unit tests.
 *
 * Exercises: round-trip with appender, malformed-line tolerance,
 * partial-trailing-line detection, tailLines, seekByLineId.
 */
import { describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlAppender } from '../../../src/db/session-jsonl/appender.ts';
import { makeFsyncPolicy } from '../../../src/db/session-jsonl/fsync-policy.ts';
import { JsonlReader } from '../../../src/db/session-jsonl/reader.ts';

function makeLayout(): { sessionsDir: string } {
  return { sessionsDir: mkdtempSync(join(tmpdir(), 'vinyan-reader-')) };
}

function newAppender(layout: { sessionsDir: string }) {
  let counter = 0;
  return new JsonlAppender({
    layout,
    policy: makeFsyncPolicy('none'),
    now: () => 1_700_000_000_000 + counter,
    newId: () => `id-${++counter}`,
  });
}

describe('JsonlReader', () => {
  test('returns no lines for an unknown session (empty result, no throw)', () => {
    const layout = makeLayout();
    const reader = new JsonlReader(layout);
    const result = reader.scanAll('absent');
    expect(result.lines).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.endOffset).toBe(0);
  });

  test('round-trips appends in order with byte-offset metadata', async () => {
    const layout = makeLayout();
    const appender = newAppender(layout);
    const sessionId = 'sess-A';

    const written = [];
    for (let i = 0; i < 5; i++) {
      const result = await appender.append(sessionId, {
        kind: 'turn.appended',
        payload: { turnId: `t${i}`, role: i % 2 === 0 ? 'user' : 'assistant', blocks: [] },
        actor: { kind: i % 2 === 0 ? 'user' : 'agent' },
      });
      written.push(result);
    }

    const reader = new JsonlReader(layout);
    const result = reader.scanAll(sessionId);
    expect(result.errors).toEqual([]);
    expect(result.lines).toHaveLength(5);
    for (let i = 0; i < 5; i++) {
      expect(result.lines[i]?.line.seq).toBe(i);
      expect(result.lines[i]?.line.lineId).toBe(written[i]?.line.lineId);
      expect(result.lines[i]?.byteOffset).toBe(written[i]?.byteOffset);
      expect(result.lines[i]?.byteLength).toBe(written[i]!.byteLength - 1); // newline excluded
    }
    expect(result.endOffset).toBe(written[written.length - 1]!.byteOffset + written[written.length - 1]!.byteLength);
  });

  test('reports malformed lines via the errors array but keeps reading', () => {
    const layout = makeLayout();
    const sessionId = 'sess-M';
    const dir = join(layout.sessionsDir, sessionId);
    mkdirSync(dir, { recursive: true });
    const events = join(dir, 'events.jsonl');

    const valid = {
      v: 1,
      lineId: 'g',
      parentLineId: null,
      sessionId,
      seq: 0,
      ts: 1,
      actor: { kind: 'user' },
      kind: 'session.created',
      payload: {},
    };
    const garbage = '{"this is not": "valid envelope"}';
    writeFileSync(
      events,
      `${JSON.stringify(valid)}\n${garbage}\n${JSON.stringify({ ...valid, lineId: 'h', seq: 1, parentLineId: 'g' })}\n`,
    );

    const reader = new JsonlReader(layout);
    const result = reader.scanAll(sessionId);
    expect(result.lines.map((l) => l.line.lineId)).toEqual(['g', 'h']);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.raw).toBe(garbage);
  });

  test('detects partial trailing line (no terminating newline)', () => {
    const layout = makeLayout();
    const sessionId = 'sess-P';
    const dir = join(layout.sessionsDir, sessionId);
    mkdirSync(dir, { recursive: true });
    const events = join(dir, 'events.jsonl');

    const valid = {
      v: 1,
      lineId: 'g',
      parentLineId: null,
      sessionId,
      seq: 0,
      ts: 1,
      actor: { kind: 'user' },
      kind: 'session.created',
      payload: {},
    };
    writeFileSync(events, `${JSON.stringify(valid)}\n{"partial":true,`);

    const reader = new JsonlReader(layout);
    const result = reader.scanAll(sessionId);
    expect(result.lines).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.reason).toContain('partial');
  });

  test('tailLines returns the newest n in append order', async () => {
    const layout = makeLayout();
    const appender = newAppender(layout);
    const sessionId = 'sess-T';
    for (let i = 0; i < 7; i++) {
      await appender.append(sessionId, {
        kind: 'turn.appended',
        payload: { turnId: `t${i}`, role: 'user', blocks: [] },
        actor: { kind: 'user' },
      });
    }
    const reader = new JsonlReader(layout);
    const tail = reader.tailLines(sessionId, 3);
    expect(tail.map((l) => l.line.seq)).toEqual([4, 5, 6]);
    expect(reader.tailLines(sessionId, 0)).toEqual([]);
    expect(reader.tailLines(sessionId, 100).map((l) => l.line.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  test('seekByLineId finds an existing line, returns undefined otherwise', async () => {
    const layout = makeLayout();
    const appender = newAppender(layout);
    const sessionId = 'sess-S';
    const a = await appender.append(sessionId, {
      kind: 'session.created',
      payload: {},
      actor: { kind: 'user' },
    });
    const reader = new JsonlReader(layout);
    expect(reader.seekByLineId(sessionId, a.line.lineId)?.line.lineId).toBe(a.line.lineId);
    expect(reader.seekByLineId(sessionId, 'missing')).toBeUndefined();
  });

  test('handles a file ending exactly on a newline (no partial)', async () => {
    const layout = makeLayout();
    const appender = newAppender(layout);
    const sessionId = 'sess-clean';
    await appender.append(sessionId, {
      kind: 'session.created',
      payload: {},
      actor: { kind: 'user' },
    });
    // Add a trailing newline manually — should not be reported as partial.
    appendFileSync(join(layout.sessionsDir, sessionId, 'events.jsonl'), '');
    const reader = new JsonlReader(layout);
    const result = reader.scanAll(sessionId);
    expect(result.errors).toEqual([]);
    expect(result.lines).toHaveLength(1);
  });
});
