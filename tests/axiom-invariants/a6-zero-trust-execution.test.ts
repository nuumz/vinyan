/**
 * A6 — Zero-Trust Execution invariant.
 *
 * Workers propose; orchestrator disposes. The artifact-commit gate must
 * reject paths that would escape the workspace, contain `..` traversal,
 * be absolute, or land on a symlink. Two-pass fail-closed: if ANY path
 * fails preflight, NO writes happen.
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  commitArtifacts,
  validateArtifactPath,
} from '../../src/orchestrator/worker/artifact-commit.ts';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vinyan-a6-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('A6 — Zero-Trust Execution', () => {
  test('rejects absolute paths', () => {
    const r = validateArtifactPath(tmp, '/etc/passwd');
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('Absolute path');
  });

  test('rejects parent-traversal paths', () => {
    const r = validateArtifactPath(tmp, '../escape.ts');
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('traversal');
  });

  test('rejects writes to symlinked targets', () => {
    mkdirSync(join(tmp, 'pages'), { recursive: true });
    symlinkSync('/tmp', join(tmp, 'pages', 'redirect'));
    const r = validateArtifactPath(tmp, 'pages/redirect');
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('symlink');
  });

  test('two-pass fail-closed: one bad path means NO writes happen', () => {
    const result = commitArtifacts(tmp, [
      { path: 'src/good.ts', content: 'export const ok = true;' },
      { path: '../escape.ts', content: 'malicious' },
    ]);
    // The invariant: nothing applied because preflight failed on one path.
    expect(result.applied.length).toBe(0);
    // The bad path is reported.
    expect(result.rejected.some((r) => r.path === '../escape.ts')).toBe(true);
    // And the good file was NOT written to disk (no side effect).
    const fs = require('node:fs') as typeof import('node:fs');
    expect(fs.existsSync(`${tmp}/src/good.ts`)).toBe(false);
  });

  test('clean batch writes successfully under workspace', () => {
    const result = commitArtifacts(tmp, [
      { path: 'src/a.ts', content: 'export const a = 1;' },
      { path: 'src/b.ts', content: 'export const b = 2;' },
    ]);
    expect(result.applied.length).toBe(2);
    expect(result.rejected.length).toBe(0);
  });
});
