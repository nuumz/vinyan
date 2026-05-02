/**
 * Phase 5 — segment rotation invariants.
 *
 * Asserts:
 *   1. Appender rotates the active segment after a write pushes it
 *      past the configured cap; the rotated file is sealed under the
 *      `events.NNNN.jsonl` naming convention.
 *   2. The manifest captures correct first/last lineId + seq for
 *      sealed segments.
 *   3. Reader iterates sealed segments + active in append order.
 *   4. Backward compat: sessions with no manifest read as single-file
 *      (Phase 1-4 layout still works).
 *   5. Cursor + chain stay correct across rotations: seq is gapless,
 *      parentLineId chains across segment boundaries.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlAppender } from '../../../src/db/session-jsonl/appender.ts';
import { makeFsyncPolicy } from '../../../src/db/session-jsonl/fsync-policy.ts';
import { sessionFiles } from '../../../src/db/session-jsonl/paths.ts';
import { JsonlReader } from '../../../src/db/session-jsonl/reader.ts';
import { readManifest } from '../../../src/db/session-jsonl/segments.ts';

function makeLayout(): { sessionsDir: string } {
  return { sessionsDir: mkdtempSync(join(tmpdir(), 'vinyan-segments-')) };
}

function newAppender(layout: { sessionsDir: string }, maxBytesPerSegment: number): JsonlAppender {
  let counter = 0;
  return new JsonlAppender({
    layout,
    policy: makeFsyncPolicy('none'),
    now: () => 1_700_000_000_000 + counter,
    newId: () => `id-${++counter}`,
    maxBytesPerSegment,
  });
}

describe('Segment rotation', () => {
  test('first write does not trigger rotation', async () => {
    const layout = makeLayout();
    const appender = newAppender(layout, 64 * 1024); // 64 KB cap, plenty for one line
    await appender.append('s1', {
      kind: 'turn.appended',
      payload: { turnId: 't1', role: 'user', blocks: [] },
      actor: { kind: 'user' },
    });
    const manifest = readManifest(layout, 's1');
    expect(manifest.sealed).toEqual([]);
    expect(existsSync(sessionFiles(layout, 's1').events)).toBe(true);
  });

  test('rotates active segment when its size exceeds the cap', async () => {
    const layout = makeLayout();
    // Cap is intentionally tiny so two normal lines push past it.
    const appender = newAppender(layout, 200);

    const a = await appender.append('s2', {
      kind: 'turn.appended',
      payload: { turnId: 't1', role: 'user', blocks: [] },
      actor: { kind: 'user' },
    });
    expect(readManifest(layout, 's2').sealed).toEqual([]);

    const b = await appender.append('s2', {
      kind: 'turn.appended',
      payload: { turnId: 't2', role: 'assistant', blocks: [] },
      actor: { kind: 'agent' },
    });

    // After the second append the active segment crossed 200 bytes.
    const manifest = readManifest(layout, 's2');
    expect(manifest.sealed).toHaveLength(1);
    const sealed = manifest.sealed[0]!;
    expect(sealed.name).toBe('events.0000.jsonl');
    expect(sealed.firstLineId).toBe(a.line.lineId);
    expect(sealed.lastLineId).toBe(b.line.lineId);
    expect(sealed.firstSeq).toBe(0);
    expect(sealed.lastSeq).toBe(1);
    expect(sealed.size).toBeGreaterThan(0);

    // Active segment is now empty / fresh.
    const dir = sessionFiles(layout, 's2').dir;
    const sealedPath = join(dir, 'events.0000.jsonl');
    expect(existsSync(sealedPath)).toBe(true);
    // Sealed file has both lines.
    const sealedContent = readFileSync(sealedPath, 'utf-8');
    expect(sealedContent.split('\n').filter((l) => l.length > 0)).toHaveLength(2);
  });

  test('seq + parentLineId chain unbroken across rotations', async () => {
    const layout = makeLayout();
    const appender = newAppender(layout, 200);

    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const r = await appender.append('s3', {
        kind: 'turn.appended',
        payload: { turnId: `t${i}`, role: 'user', blocks: [] },
        actor: { kind: 'user' },
      });
      ids.push(r.line.lineId);
    }

    const reader = new JsonlReader(layout);
    const lines = reader.scanAll('s3').lines;
    expect(lines.map((l) => l.line.seq)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(lines.map((l) => l.line.lineId)).toEqual(ids);

    // parent chain: every line's parentLineId is the previous line's id.
    for (let i = 1; i < lines.length; i++) {
      expect(lines[i]?.line.parentLineId).toBe(lines[i - 1]?.line.lineId);
    }

    // Rotation produced multiple sealed segments under this tiny cap.
    const manifest = readManifest(layout, 's3');
    expect(manifest.sealed.length).toBeGreaterThan(0);
    expect(manifest.sealed.length).toBeLessThan(lines.length);
  });

  test('reader is backward-compatible when no manifest exists', async () => {
    const layout = makeLayout();
    const appender = newAppender(layout, 1024 * 1024); // huge cap → never rotate
    await appender.append('s4', {
      kind: 'session.created',
      payload: {},
      actor: { kind: 'cli' },
    });
    const manifest = readManifest(layout, 's4');
    expect(manifest.sealed).toEqual([]);
    const lines = new JsonlReader(layout).scanAll('s4').lines;
    expect(lines).toHaveLength(1);
  });

  test('reader returns an empty result for an unknown session', () => {
    const layout = makeLayout();
    const lines = new JsonlReader(layout).scanAll('does-not-exist').lines;
    expect(lines).toEqual([]);
  });
});
