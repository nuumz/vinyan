/**
 * Simple skill registry tests — composes loader + watcher into a refreshable
 * in-memory cache. Covers cold-start, version bumping on refresh, and watcher
 * lifecycle.
 *
 * Note: filesystem-watcher events are inherently flaky in unit tests (debounce +
 * platform timing). We test the watcher path with a small explicit wait, and
 * keep most assertions on the deterministic loader-composition path via
 * `watch: false`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSimpleSkillRegistry } from '../../../src/skills/simple/registry.ts';

let userDir: string;
let projectDir: string;
let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'simple-reg-ws-'));
  userDir = mkdtempSync(join(tmpdir(), 'simple-reg-user-'));
  projectDir = mkdtempSync(join(tmpdir(), 'simple-reg-proj-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(userDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

function plant(rootDir: string, name: string, description: string): void {
  const dir = join(rootDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\nbody for ${name}\n`,
  );
}

describe('createSimpleSkillRegistry — cold start', () => {
  test('loads skills from both scopes at construction', () => {
    plant(userDir, 'user-skill', 'user version');
    plant(projectDir, 'proj-skill', 'project version');

    const reg = createSimpleSkillRegistry({
      workspace,
      userSkillsDir: userDir,
      projectSkillsDir: projectDir,
      watch: false,
    });
    try {
      const all = reg.getAll();
      expect(all.length).toBe(2);
      expect(all.map((s) => s.name).sort()).toEqual(['proj-skill', 'user-skill']);
      expect(reg.getVersion()).toBe(1);
    } finally {
      reg.close();
    }
  });

  test('getByName returns the skill', () => {
    plant(projectDir, 'foo', 'desc');
    const reg = createSimpleSkillRegistry({
      workspace,
      userSkillsDir: userDir,
      projectSkillsDir: projectDir,
      watch: false,
    });
    try {
      expect(reg.getByName('foo')?.name).toBe('foo');
      expect(reg.getByName('missing')).toBeNull();
    } finally {
      reg.close();
    }
  });

  test('empty scopes → empty list, version still 1', () => {
    const reg = createSimpleSkillRegistry({
      workspace,
      userSkillsDir: userDir,
      projectSkillsDir: projectDir,
      watch: false,
    });
    try {
      expect(reg.getAll()).toEqual([]);
      expect(reg.getVersion()).toBe(1);
    } finally {
      reg.close();
    }
  });
});

describe('createSimpleSkillRegistry — close()', () => {
  test('close is idempotent and safe to call without watcher', () => {
    const reg = createSimpleSkillRegistry({
      workspace,
      userSkillsDir: userDir,
      projectSkillsDir: projectDir,
      watch: false,
    });
    reg.close();
    reg.close(); // second call must not throw
    expect(() => reg.getAll()).not.toThrow();
  });
});

describe('createSimpleSkillRegistry — watcher integration', () => {
  test('refresh on add picks up new skill and bumps version', async () => {
    const reg = createSimpleSkillRegistry({
      workspace,
      userSkillsDir: userDir,
      projectSkillsDir: projectDir,
      watch: true,
      watcherDebounceMs: 30,
    });
    try {
      expect(reg.getAll().length).toBe(0);
      const startVersion = reg.getVersion();

      plant(projectDir, 'late', 'added later');
      await waitFor(() => reg.getAll().length === 1, 1500);

      expect(reg.getByName('late')).not.toBeNull();
      expect(reg.getVersion()).toBeGreaterThan(startVersion);
    } finally {
      reg.close();
    }
  });

  test('refresh on remove drops the skill', async () => {
    plant(projectDir, 'temp', 'will go away');
    const reg = createSimpleSkillRegistry({
      workspace,
      userSkillsDir: userDir,
      projectSkillsDir: projectDir,
      watch: true,
      watcherDebounceMs: 30,
    });
    try {
      expect(reg.getAll().length).toBe(1);

      unlinkSync(join(projectDir, 'temp', 'SKILL.md'));
      await waitFor(() => reg.getAll().length === 0, 1500);

      expect(reg.getByName('temp')).toBeNull();
    } finally {
      reg.close();
    }
  });
});

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`waitFor: predicate did not pass within ${timeoutMs}ms`);
}
