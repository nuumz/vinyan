/**
 * GET /api/v1/files/check-hash — A8 evidence-stale endpoint.
 *
 * The route is purely a wrapper around `verifyFileHash`, but it carries
 * three claims under test:
 *
 *   1. Workspace-relative paths are checked against disk and the verdict
 *      reports `match: true` for unchanged files.
 *   2. A modified file flips to `match: false` with the actual hash.
 *   3. Path-traversal (`../etc/passwd`) is rejected with HTTP 400 — the
 *      browser-callable endpoint must not leak hashes for files outside
 *      the workspace root.
 *
 * The handler itself is exercised through `verifyFileHash` directly here
 * (no need to spin up a Bun server); the boundary check is reproduced in
 * the test setup so the same `pathRelative` rule is asserted.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative as pathRelative, resolve as pathResolve } from 'node:path';
import { verifyFileHash } from '../../src/gate/content-hash-verifier.ts';

let workspace: string;

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function isWithinWorkspace(workspaceRoot: string, requestedPath: string): boolean {
  if (isAbsolute(requestedPath)) return false;
  const absResolved = pathResolve(workspaceRoot, requestedPath);
  const rel = pathRelative(workspaceRoot, absResolved);
  return !rel.startsWith('..') && !isAbsolute(rel);
}

beforeEach(() => {
  workspace = join(tmpdir(), `vinyan-files-check-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('verifyFileHash', () => {
  test('returns match=true when content matches the expected sha256', () => {
    const content = 'export const x = 1;\n';
    writeFileSync(join(workspace, 'foo.ts'), content);
    const expected = sha256(content);

    const result = verifyFileHash(workspace, 'foo.ts', expected);
    expect(result.match).toBe(true);
    expect(result.actual).toBe(expected);
    expect(result.missing).toBe(false);
  });

  test('returns match=false when file content drifted', () => {
    const original = 'export const x = 1;\n';
    writeFileSync(join(workspace, 'foo.ts'), original);
    const expected = sha256(original);

    writeFileSync(join(workspace, 'foo.ts'), 'export const x = 2;\n');
    const result = verifyFileHash(workspace, 'foo.ts', expected);
    expect(result.match).toBe(false);
    expect(result.actual).not.toBe(expected);
    expect(result.missing).toBe(false);
  });

  test('returns missing=true for a deleted file (and reports sha256 of empty string)', () => {
    const expected = sha256('something');
    const result = verifyFileHash(workspace, 'never-existed.ts', expected);
    expect(result.match).toBe(false);
    expect(result.missing).toBe(true);
    expect(result.actual).toBe(sha256(''));
  });
});

describe('workspace boundary check (route handler invariant)', () => {
  test('accepts a workspace-relative path inside the root', () => {
    expect(isWithinWorkspace(workspace, 'src/foo.ts')).toBe(true);
    expect(isWithinWorkspace(workspace, './foo.ts')).toBe(true);
  });

  test('rejects parent-directory traversal', () => {
    expect(isWithinWorkspace(workspace, '../etc/passwd')).toBe(false);
    expect(isWithinWorkspace(workspace, '../../etc/passwd')).toBe(false);
    expect(isWithinWorkspace(workspace, 'src/../../../etc/passwd')).toBe(false);
  });

  test('rejects absolute paths', () => {
    expect(isWithinWorkspace(workspace, '/etc/passwd')).toBe(false);
  });
});
