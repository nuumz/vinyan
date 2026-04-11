import { describe, expect, test } from 'bun:test';
import { searchGrep, shellExec } from '../../../src/orchestrator/tools/built-in-tools.ts';
import type { ToolContext } from '../../../src/orchestrator/tools/tool-interface.ts';

const WORKSPACE = '/tmp/vinyan-test-workspace';
const context: ToolContext = {
  routingLevel: 2,
  allowedPaths: [],
  workspace: WORKSPACE,
};

describe('Path traversal guards', () => {
  describe('search_grep', () => {
    test("path '../../../etc/passwd' → error: escapes workspace", async () => {
      const result = await searchGrep.execute({ pattern: 'root', path: '../../../etc/passwd' }, context);
      expect(result.status).toBe('error');
      expect(result.error).toContain('escapes workspace');
    });

    test("path '/etc/passwd' (absolute) → error: escapes workspace", async () => {
      const result = await searchGrep.execute({ pattern: 'root', path: '/etc/passwd' }, context);
      expect(result.status).toBe('error');
      expect(result.error).toContain('escapes workspace');
    });

    test("path '..' → error: escapes workspace", async () => {
      const result = await searchGrep.execute({ pattern: 'test', path: '..' }, context);
      expect(result.status).toBe('error');
      expect(result.error).toContain('escapes workspace');
    });

    test("path 'subdir/../../../etc' → error: escapes workspace", async () => {
      const result = await searchGrep.execute({ pattern: 'test', path: 'subdir/../../../etc' }, context);
      expect(result.status).toBe('error');
      expect(result.error).toContain('escapes workspace');
    });

    test("path '.' (current dir) → allowed (no traversal error)", async () => {
      const result = await searchGrep.execute({ pattern: 'test', path: '.' }, context);
      // May error for other reasons (dir doesn't exist), but NOT for traversal
      if (result.status === 'error') {
        expect(result.error).not.toContain('escapes workspace');
      }
    });
  });

  describe('shell_exec', () => {
    test("cwd '../../../' → error: escapes workspace", async () => {
      const result = await shellExec.execute({ command: 'ls', cwd: '../../../' }, context);
      expect(result.status).toBe('error');
      expect(result.error).toContain('escapes workspace');
    });

    test("cwd '/etc' (absolute) → error: escapes workspace", async () => {
      const result = await shellExec.execute({ command: 'ls', cwd: '/etc' }, context);
      expect(result.status).toBe('error');
      expect(result.error).toContain('escapes workspace');
    });

    test("cwd '..' → error: escapes workspace", async () => {
      const result = await shellExec.execute({ command: 'echo hi', cwd: '..' }, context);
      expect(result.status).toBe('error');
      expect(result.error).toContain('escapes workspace');
    });

    test('no cwd → uses workspace (no traversal error)', async () => {
      const result = await shellExec.execute({ command: 'echo ok' }, context);
      // May error for other reasons, but NOT for traversal
      if (result.status === 'error') {
        expect(result.error).not.toContain('escapes workspace');
      }
    });
  });
});
