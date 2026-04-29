import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { commitArtifacts, validateArtifactPath } from '../../../src/orchestrator/worker/artifact-commit.ts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'vinyan-artifact-'));
  mkdirSync(join(tempDir, 'src'), { recursive: true });
  writeFileSync(join(tempDir, 'src', 'existing.ts'), 'original content');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('validateArtifactPath', () => {
  test('accepts relative path within workspace', () => {
    expect(validateArtifactPath(tempDir, 'src/foo.ts').valid).toBe(true);
  });

  test('rejects absolute path', () => {
    const result = validateArtifactPath(tempDir, '/etc/passwd');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Absolute path');
  });

  test("rejects path with '..' traversal", () => {
    const result = validateArtifactPath(tempDir, 'src/../../etc/passwd');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('..');
  });

  test('rejects path that escapes workspace after resolution', () => {
    // Path without '..' but still escapes (edge case)
    const result = validateArtifactPath(tempDir, 'src/../../outside');
    expect(result.valid).toBe(false);
  });

  test('rejects symlink target', () => {
    const linkPath = join(tempDir, 'src', 'link.ts');
    symlinkSync(join(tempDir, 'src', 'existing.ts'), linkPath);

    const result = validateArtifactPath(tempDir, 'src/link.ts');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('symlink');
  });

  test("accepts new file (doesn't exist yet)", () => {
    expect(validateArtifactPath(tempDir, 'src/new-file.ts').valid).toBe(true);
  });

  test('accepts nested new path', () => {
    expect(validateArtifactPath(tempDir, 'src/deep/nested/file.ts').valid).toBe(true);
  });
});

describe('commitArtifacts', () => {
  test('applies valid artifacts to workspace', () => {
    const result = commitArtifacts(tempDir, [{ path: 'src/new.ts', content: 'export const x = 1;\n' }]);

    expect(result.applied).toEqual(['src/new.ts']);
    expect(result.rejected).toHaveLength(0);
    expect(readFileSync(join(tempDir, 'src/new.ts'), 'utf-8')).toBe('export const x = 1;\n');
  });

  test('creates nested directories as needed', () => {
    const result = commitArtifacts(tempDir, [{ path: 'src/deep/nested/file.ts', content: 'content' }]);

    expect(result.applied).toEqual(['src/deep/nested/file.ts']);
    expect(readFileSync(join(tempDir, 'src/deep/nested/file.ts'), 'utf-8')).toBe('content');
  });

  test('fail-closed: any unsafe path rejects the whole batch (no writes)', () => {
    const result = commitArtifacts(tempDir, [
      { path: 'src/safe.ts', content: 'safe' },
      { path: '/etc/passwd', content: 'hacked' },
      { path: 'src/../../../escape.ts', content: 'evil' },
    ]);

    expect(result.applied).toHaveLength(0);
    expect(result.rejected).toHaveLength(2);
    expect(result.rejected[0]!.reason).toContain('Absolute');
    expect(result.rejected[1]!.reason).toContain('..');
    // Safe file must NOT have been written under preflight semantics.
    expect(() => readFileSync(join(tempDir, 'src/safe.ts'), 'utf-8')).toThrow();
  });

  test('fail-closed: symlink target in batch rejects the whole batch', () => {
    const linkPath = join(tempDir, 'src', 'link.ts');
    symlinkSync(join(tempDir, 'src', 'existing.ts'), linkPath);

    const result = commitArtifacts(tempDir, [
      { path: 'src/safe2.ts', content: 'safe' },
      { path: 'src/link.ts', content: 'overwrite-via-symlink' },
    ]);

    expect(result.applied).toHaveLength(0);
    expect(result.rejected.some((r) => r.reason.includes('symlink'))).toBe(true);
    expect(() => readFileSync(join(tempDir, 'src/safe2.ts'), 'utf-8')).toThrow();
  });

  test('overwrites existing file', () => {
    const result = commitArtifacts(tempDir, [{ path: 'src/existing.ts', content: 'new content' }]);

    expect(result.applied).toEqual(['src/existing.ts']);
    expect(readFileSync(join(tempDir, 'src/existing.ts'), 'utf-8')).toBe('new content');
  });

  test('empty artifacts returns empty result', () => {
    const result = commitArtifacts(tempDir, []);
    expect(result.applied).toHaveLength(0);
    expect(result.rejected).toHaveLength(0);
  });
});
