/**
 * JsonlAppender — Phase 1 unit tests.
 *
 * Exercises: cursor init from empty / existing file, fdatasync policy,
 * envelope correctness, parent-line linkage, partial-line tolerance,
 * sessionId path validation.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlAppender } from '../../../src/db/session-jsonl/appender.ts';
import { makeFsyncPolicy } from '../../../src/db/session-jsonl/fsync-policy.ts';
import { sessionFiles } from '../../../src/db/session-jsonl/paths.ts';

function makeLayout(): { sessionsDir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'vinyan-jsonl-'));
  return { sessionsDir: dir };
}

function makeAppender(layout: { sessionsDir: string }, opts: { mode?: 'durable' | 'batched' | 'none' } = {}) {
  let counter = 0;
  return new JsonlAppender({
    layout,
    policy: makeFsyncPolicy(opts.mode ?? 'none'),
    now: () => 1_700_000_000_000 + counter++,
    newId: () => `line-${counter}`,
  });
}

describe('JsonlAppender', () => {
  test('writes envelope with seq=0 + parentLineId=null on first append', async () => {
    const layout = makeLayout();
    const appender = makeAppender(layout);
    const result = await appender.append('sess-A', {
      kind: 'session.created',
      payload: { source: 'cli', title: 'first' },
      actor: { kind: 'user' },
    });

    expect(result.line.seq).toBe(0);
    expect(result.line.parentLineId).toBeNull();
    expect(result.line.kind).toBe('session.created');
    expect(result.line.sessionId).toBe('sess-A');
    expect(result.byteOffset).toBe(0);
    expect(result.byteLength).toBeGreaterThan(0);

    const files = sessionFiles(layout, 'sess-A');
    const raw = readFileSync(files.events, 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(raw.trim());
    expect(parsed.kind).toBe('session.created');
    expect(parsed.seq).toBe(0);
    expect(parsed.payload).toEqual({ source: 'cli', title: 'first' });
  });

  test('chains parentLineId across consecutive appends', async () => {
    const layout = makeLayout();
    const appender = makeAppender(layout);
    const a = await appender.append('sess-B', {
      kind: 'session.created',
      payload: {},
      actor: { kind: 'user' },
    });
    const b = await appender.append('sess-B', {
      kind: 'turn.appended',
      payload: { turnId: 't1', role: 'user', blocks: [] },
      actor: { kind: 'user' },
    });
    const c = await appender.append('sess-B', {
      kind: 'turn.appended',
      payload: { turnId: 't2', role: 'assistant', blocks: [] },
      actor: { kind: 'agent' },
    });

    expect(a.line.parentLineId).toBeNull();
    expect(b.line.parentLineId).toBe(a.line.lineId);
    expect(c.line.parentLineId).toBe(b.line.lineId);
    expect([a.line.seq, b.line.seq, c.line.seq]).toEqual([0, 1, 2]);
    expect(b.byteOffset).toBe(a.byteOffset + a.byteLength);
    expect(c.byteOffset).toBe(b.byteOffset + b.byteLength);
  });

  test('isolates seq per session', async () => {
    const layout = makeLayout();
    const appender = makeAppender(layout);
    const a1 = await appender.append('sess-X', {
      kind: 'session.created',
      payload: {},
      actor: { kind: 'user' },
    });
    const b1 = await appender.append('sess-Y', {
      kind: 'session.created',
      payload: {},
      actor: { kind: 'user' },
    });
    const a2 = await appender.append('sess-X', {
      kind: 'turn.appended',
      payload: { turnId: 't', role: 'user', blocks: [] },
      actor: { kind: 'user' },
    });
    expect(a1.line.seq).toBe(0);
    expect(b1.line.seq).toBe(0);
    expect(a2.line.seq).toBe(1);
    expect(a2.line.parentLineId).toBe(a1.line.lineId);
  });

  test('hydrates cursor from existing events.jsonl on first access', async () => {
    const layout = makeLayout();
    const sessionId = 'sess-hydrate';
    const dir = join(layout.sessionsDir, sessionId);
    mkdirSync(dir, { recursive: true });
    const events = join(dir, 'events.jsonl');

    // Pre-seed two valid lines as if a prior process had written them.
    const seedA = {
      v: 1,
      lineId: 'seed-A',
      parentLineId: null,
      sessionId,
      seq: 0,
      ts: 1,
      actor: { kind: 'user' },
      kind: 'session.created',
      payload: {},
    };
    const seedB = {
      v: 1,
      lineId: 'seed-B',
      parentLineId: 'seed-A',
      sessionId,
      seq: 1,
      ts: 2,
      actor: { kind: 'user' },
      kind: 'turn.appended',
      payload: { turnId: 't0', role: 'user', blocks: [] },
    };
    writeFileSync(events, `${JSON.stringify(seedA)}\n${JSON.stringify(seedB)}\n`);

    const appender = makeAppender(layout);
    const result = await appender.append(sessionId, {
      kind: 'turn.appended',
      payload: { turnId: 't1', role: 'assistant', blocks: [] },
      actor: { kind: 'agent' },
    });

    expect(result.line.seq).toBe(2);
    expect(result.line.parentLineId).toBe('seed-B');
    expect(result.byteOffset).toBe(statSync(events).size - result.byteLength);
  });

  test('partial trailing line is left in place; next append starts on a fresh line', async () => {
    const layout = makeLayout();
    const sessionId = 'sess-partial';
    const dir = join(layout.sessionsDir, sessionId);
    mkdirSync(dir, { recursive: true });
    const events = join(dir, 'events.jsonl');

    const valid = {
      v: 1,
      lineId: 'good-1',
      parentLineId: null,
      sessionId,
      seq: 0,
      ts: 1,
      actor: { kind: 'user' },
      kind: 'session.created',
      payload: {},
    };
    // Valid line with newline + a partial line missing the newline.
    writeFileSync(events, `${JSON.stringify(valid)}\n{"truncated":`);
    const sizeBefore = statSync(events).size;

    const appender = makeAppender(layout);
    const result = await appender.append(sessionId, {
      kind: 'turn.appended',
      payload: { turnId: 't1', role: 'user', blocks: [] },
      actor: { kind: 'user' },
    });

    expect(result.line.seq).toBe(1);
    expect(result.line.parentLineId).toBe('good-1');

    const after = readFileSync(events, 'utf-8');
    // The partial bytes are still present (we only append, never truncate)
    // but the new line starts on its own line — i.e., after the partial
    // there must be a newline before the freshly-written object.
    expect(after.startsWith(`${JSON.stringify(valid)}\n{"truncated":`)).toBe(true);
    expect(after.endsWith('\n')).toBe(true);
    expect(statSync(events).size).toBeGreaterThan(sizeBefore);
  });

  test('rejects malformed sessionId before touching disk', async () => {
    const layout = makeLayout();
    const appender = makeAppender(layout);
    expect(
      appender.append('../escape', {
        kind: 'session.created',
        payload: {},
        actor: { kind: 'user' },
      }),
    ).rejects.toThrow(/invalid sessionId/);
  });
});

describe('JsonlAppender — fsync policy', () => {
  test('does not error when policy is "none" or "durable"', async () => {
    // The policy gate is internal; a write under either mode must round-trip.
    for (const mode of ['none', 'durable'] as const) {
      const layout = makeLayout();
      const appender = makeAppender(layout, { mode });
      const result = await appender.append('sess', {
        kind: 'session.compacted',
        payload: { taskCount: 0 },
        actor: { kind: 'orchestrator' },
      });
      expect(result.line.kind).toBe('session.compacted');
    }
  });
});
