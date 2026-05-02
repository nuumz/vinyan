/**
 * Phase 5 — `snapshot.json` sidecar.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureSessionDir, sessionFiles } from '../../../src/db/session-jsonl/paths.ts';
import { readSnapshot, snapshotIsCurrent, writeSnapshot } from '../../../src/db/session-jsonl/snapshot.ts';

function makeLayout(): { sessionsDir: string } {
  return { sessionsDir: mkdtempSync(join(tmpdir(), 'vinyan-snapshot-')) };
}

describe('Snapshot sidecar', () => {
  test('writeSnapshot / readSnapshot round-trip', () => {
    const layout = makeLayout();
    ensureSessionDir(layout, 's1');
    writeSnapshot(layout, 's1', {
      generatedAt: 1,
      lastLineId: 'L1',
      lastLineOffset: 100,
      activeSegment: 'events.jsonl',
      state: { metadata: { id: 's1' }, latestTurns: [] },
    });
    const loaded = readSnapshot(layout, 's1');
    expect(loaded?.lastLineId).toBe('L1');
    expect(loaded?.lastLineOffset).toBe(100);
    expect(loaded?.version).toBe(1);
  });

  test('readSnapshot returns null for an unknown session', () => {
    const layout = makeLayout();
    ensureSessionDir(layout, 's2');
    expect(readSnapshot(layout, 's2')).toBeNull();
  });

  test('readSnapshot returns null for a corrupt file', () => {
    const layout = makeLayout();
    const files = sessionFiles(layout, 's3');
    ensureSessionDir(layout, 's3');
    writeFileSync(files.snapshot, '{not valid json');
    expect(readSnapshot(layout, 's3')).toBeNull();
  });

  test('snapshotIsCurrent compares activeSegment and offset', () => {
    const snap = {
      version: 1 as const,
      generatedAt: 1,
      lastLineId: 'L1',
      lastLineOffset: 200,
      activeSegment: 'events.jsonl',
      state: {},
    };
    expect(snapshotIsCurrent(snap, { activeSegment: 'events.jsonl', activeSize: 200 })).toBe(true);
    expect(snapshotIsCurrent(snap, { activeSegment: 'events.jsonl', activeSize: 250 })).toBe(false);
    expect(snapshotIsCurrent(snap, { activeSegment: 'events.0001.jsonl', activeSize: 200 })).toBe(false);
  });

  test('snapshot file is written atomically (no half-written state visible)', () => {
    const layout = makeLayout();
    ensureSessionDir(layout, 's4');
    writeSnapshot(layout, 's4', {
      generatedAt: 1,
      lastLineId: null,
      lastLineOffset: 0,
      activeSegment: 'events.jsonl',
      state: {},
    });
    // The implementation uses a temp file + rename; we cannot directly
    // observe the temp file from an async test, but we can confirm that
    // after the call returns, the destination is well-formed JSON.
    const loaded = readSnapshot(layout, 's4');
    expect(loaded).not.toBeNull();
    expect(existsSync(sessionFiles(layout, 's4').snapshot)).toBe(true);
  });
});
