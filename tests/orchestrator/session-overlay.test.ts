import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionOverlay } from '../../src/orchestrator/agent/session-overlay';

let workspace: string;
let overlay: SessionOverlay;

beforeEach(() => {
  workspace = join(tmpdir(), `vinyan-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  try {
    overlay?.cleanup();
  } catch {
    // overlay may already be cleaned
  }
  if (existsSync(workspace)) {
    rmSync(workspace, { recursive: true, force: true });
  }
});

describe('SessionOverlay', () => {
  describe('writeFile + readFile', () => {
    it('returns overlay content after write', () => {
      overlay = SessionOverlay.create(workspace, 'task-1');
      overlay.writeFile('src/hello.ts', 'hello');
      expect(overlay.readFile('src/hello.ts')).toBe('hello');
    });
  });

  describe('readFile fallthrough', () => {
    it('falls through to workspace when not in overlay', () => {
      mkdirSync(join(workspace, 'src'), { recursive: true });
      writeFileSync(join(workspace, 'src/existing.ts'), 'workspace content', 'utf-8');

      overlay = SessionOverlay.create(workspace, 'task-2');
      expect(overlay.readFile('src/existing.ts')).toBe('workspace content');
    });
  });

  describe('deleteFile + tombstone', () => {
    it('creates tombstone; readFile returns null; listDir hides deleted file', () => {
      mkdirSync(join(workspace, 'src'), { recursive: true });
      writeFileSync(join(workspace, 'src/doomed.ts'), 'bye', 'utf-8');

      overlay = SessionOverlay.create(workspace, 'task-3');
      overlay.deleteFile('src/doomed.ts');

      expect(overlay.readFile('src/doomed.ts')).toBeNull();
      expect(overlay.listDir('src')).not.toContain('doomed.ts');
    });
  });

  describe('computeDiff', () => {
    it('produces addition, modification, and deletion mutations', () => {
      mkdirSync(join(workspace, 'src'), { recursive: true });
      writeFileSync(join(workspace, 'src/modify.ts'), 'original', 'utf-8');
      writeFileSync(join(workspace, 'src/remove.ts'), 'to delete', 'utf-8');

      overlay = SessionOverlay.create(workspace, 'task-4');

      overlay.readFile('src/modify.ts');
      overlay.writeFile('src/modify.ts', 'modified');

      overlay.writeFile('src/new-file.ts', 'brand new');

      overlay.deleteFile('src/remove.ts');

      const mutations = overlay.computeDiff();
      expect(mutations.length).toBe(3);

      const byFile = new Map(mutations.map((m) => [m.file, m]));

      const mod = byFile.get('src/modify.ts');
      expect(mod).toBeDefined();
      expect(mod!.content).toBe('modified');
      expect(mod!.explanation).toBe('File modified');

      const add = byFile.get('src/new-file.ts');
      expect(add).toBeDefined();
      expect(add!.content).toBe('brand new');
      expect(add!.explanation).toBe('New file created');

      const del = byFile.get('src/remove.ts');
      expect(del).toBeDefined();
      expect(del!.content).toBeNull();
      expect(del!.explanation).toBe('File deleted by session overlay');
    });
  });

  describe('OCC commit', () => {
    it('rejects file when workspace was modified concurrently', () => {
      mkdirSync(join(workspace, 'src'), { recursive: true });
      writeFileSync(join(workspace, 'src/conflict.ts'), 'v1', 'utf-8');

      overlay = SessionOverlay.create(workspace, 'task-5');
      overlay.readFile('src/conflict.ts');
      overlay.writeFile('src/conflict.ts', 'v2');

      // Simulate concurrent edit
      writeFileSync(join(workspace, 'src/conflict.ts'), 'v3', 'utf-8');

      const result = overlay.commit();
      expect(result.conflicts).toContain('src/conflict.ts');
      expect(result.committed).not.toContain('src/conflict.ts');

      // Workspace should still have v3
      expect(readFileSync(join(workspace, 'src/conflict.ts'), 'utf-8')).toBe('v3');
    });

    it('succeeds when hashes match', () => {
      mkdirSync(join(workspace, 'src'), { recursive: true });
      writeFileSync(join(workspace, 'src/safe.ts'), 'v1', 'utf-8');

      overlay = SessionOverlay.create(workspace, 'task-6');
      overlay.readFile('src/safe.ts');
      overlay.writeFile('src/safe.ts', 'v2');

      const result = overlay.commit();
      expect(result.committed).toContain('src/safe.ts');
      expect(result.conflicts).toHaveLength(0);

      expect(readFileSync(join(workspace, 'src/safe.ts'), 'utf-8')).toBe('v2');
    });
  });

  describe('cleanup', () => {
    it('removes session directory', () => {
      overlay = SessionOverlay.create(workspace, 'task-7');
      overlay.writeFile('test.txt', 'data');

      const dirBeforeCleanup = overlay.dir;
      expect(existsSync(dirBeforeCleanup)).toBe(true);

      overlay.cleanup();
      expect(existsSync(dirBeforeCleanup)).toBe(false);
    });
  });

  describe('path traversal', () => {
    it('blocks .. traversal', () => {
      overlay = SessionOverlay.create(workspace, 'task-8');
      expect(() => overlay.readFile('../../../etc/passwd')).toThrow('Invalid relative path');
    });

    it('blocks absolute paths', () => {
      overlay = SessionOverlay.create(workspace, 'task-8b');
      expect(() => overlay.readFile('/etc/passwd')).toThrow('Invalid relative path');
    });
  });

  describe('taskId validation', () => {
    it('rejects invalid taskId characters', () => {
      expect(() => SessionOverlay.create(workspace, 'task/../evil')).toThrow('Invalid taskId');
      expect(() => SessionOverlay.create(workspace, 'task with spaces')).toThrow('Invalid taskId');
    });
  });
});
