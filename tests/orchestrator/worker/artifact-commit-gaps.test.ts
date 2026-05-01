/**
 * Phase 6 — Gap 4 (dormant pending reload) + Gap 7 (rollback) tests.
 *
 * Gap 4: commits that land under `src/orchestrator/`, `src/core/`,
 * `src/api/`, or `src/cli/` emit `commit:dormant_pending_reload`.
 * Gap 7: with `rollbackOnPartialFailure: true`, partial Pass 2 failure
 * restores pre-write content (or unlinks newly-created files).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { EventBus, type VinyanBusEvents } from '../../../src/core/bus.ts';
import { commitArtifacts } from '../../../src/orchestrator/worker/artifact-commit.ts';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vinyan-commit-gaps-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('Gap 4 — commit:dormant_pending_reload', () => {
  test('emits when path lands under src/orchestrator/', () => {
    const bus = new EventBus<VinyanBusEvents>();
    const events: VinyanBusEvents['commit:dormant_pending_reload'][] = [];
    bus.on('commit:dormant_pending_reload', (p) => events.push(p));
    const result = commitArtifacts(
      tmp,
      [
        { path: 'src/orchestrator/foo.ts', content: 'export const x = 1;' },
        { path: 'src/skills/bar.ts', content: 'export const y = 2;' },
      ],
      { bus, taskId: 'gap4-task', actor: 'worker' },
    );
    expect(result.applied.length).toBe(2);
    expect(events.length).toBe(1);
    expect(events[0]?.affectedPaths).toContain('src/orchestrator/foo.ts');
    expect(events[0]?.affectedPaths).not.toContain('src/skills/bar.ts');
  });

  test('does NOT emit for paths outside the running orchestrator scope', () => {
    const bus = new EventBus<VinyanBusEvents>();
    const events: VinyanBusEvents['commit:dormant_pending_reload'][] = [];
    bus.on('commit:dormant_pending_reload', (p) => events.push(p));
    commitArtifacts(
      tmp,
      [{ path: 'docs/foo.md', content: '# foo' }],
      { bus, taskId: 't', actor: 'a' },
    );
    expect(events.length).toBe(0);
  });
});

describe('Gap 7 — rollback on partial failure', () => {
  test('partial failure → applied=[] and pre-existing content restored', () => {
    // Pre-existing file with original content.
    mkdirSync(join(tmp, 'src'), { recursive: true });
    writeFileSync(join(tmp, 'src/exists.ts'), 'export const original = true;');

    // Force a Pass 2 partial failure by making one path's parent
    // un-creatable: write a FILE at where the directory would need to be.
    writeFileSync(join(tmp, 'collides'), 'i am a file');

    const result = commitArtifacts(
      tmp,
      [
        { path: 'src/exists.ts', content: 'export const NEW = "value";' },
        // 'collides/sub.ts' tries to mkdirSync('collides') which fails because
        // 'collides' is already a regular file.
        { path: 'collides/sub.ts', content: 'export const z = 3;' },
      ],
      { rollbackOnPartialFailure: true },
    );

    // Rollback path: applied is empty (all-or-nothing).
    expect(result.applied.length).toBe(0);
    // Restored: pre-existing file's content is the original.
    expect(readFileSync(join(tmp, 'src/exists.ts'), 'utf-8')).toBe(
      'export const original = true;',
    );
  });

  test('without rollback flag, partial failure leaves siblings on disk (legacy MVP behavior)', () => {
    mkdirSync(join(tmp, 'src'), { recursive: true });
    writeFileSync(join(tmp, 'collides'), 'blocker');

    const result = commitArtifacts(tmp, [
      { path: 'src/sibling.ts', content: 'export const ok = 1;' },
      { path: 'collides/sub.ts', content: 'export const z = 3;' },
    ]);

    // Sibling actually got written.
    expect(result.applied).toContain('src/sibling.ts');
    expect(existsSync(join(tmp, 'src/sibling.ts'))).toBe(true);
    // Other path failed.
    expect(result.rejected.length).toBeGreaterThan(0);
  });
});
