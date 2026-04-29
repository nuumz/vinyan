/**
 * Per-agent registry filter tests.
 *
 * Verifies the registry surfaces:
 *   - getAll() returns the FULL set including all per-agent variants
 *   - getForAgent(undefined) returns shared scopes only
 *   - getForAgent(agentId) returns shared + that agent's per-agent skills only
 *   - getByName prefers shared-scope on conflicts
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSimpleSkillRegistry } from '../../../src/skills/simple/registry.ts';

let userDir: string;
let userAgentsDir: string;
let projectDir: string;
let projectAgentsDir: string;
let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'reg-pa-ws-'));
  userDir = mkdtempSync(join(tmpdir(), 'reg-pa-user-'));
  userAgentsDir = mkdtempSync(join(tmpdir(), 'reg-pa-user-agents-'));
  projectDir = mkdtempSync(join(tmpdir(), 'reg-pa-proj-'));
  projectAgentsDir = mkdtempSync(join(tmpdir(), 'reg-pa-proj-agents-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(userDir, { recursive: true, force: true });
  rmSync(userAgentsDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(projectAgentsDir, { recursive: true, force: true });
});

function plant(rootDir: string, name: string, description: string): void {
  const dir = join(rootDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`);
}

function plantAgent(agentsRoot: string, agentId: string, name: string, description: string): void {
  const dir = join(agentsRoot, agentId, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`);
}

function build() {
  return createSimpleSkillRegistry({
    workspace,
    userSkillsDir: userDir,
    projectSkillsDir: projectDir,
    userAgentsDir,
    projectAgentsDir,
    watch: false,
  });
}

describe('SimpleSkillRegistry — per-agent', () => {
  test('getAll returns the full set including per-agent variants', () => {
    plant(userDir, 'shared', 'public');
    plantAgent(userAgentsDir, 'developer', 'private', 'dev only');

    const reg = build();
    try {
      const all = reg.getAll();
      expect(all.length).toBe(2);
      expect(all.map((s) => s.name).sort()).toEqual(['private', 'shared']);
    } finally {
      reg.close();
    }
  });

  test('getForAgent(undefined) → shared scopes only', () => {
    plant(userDir, 'shared', 'a');
    plantAgent(userAgentsDir, 'developer', 'private', 'b');

    const reg = build();
    try {
      const view = reg.getForAgent(undefined);
      expect(view.length).toBe(1);
      expect(view[0]?.name).toBe('shared');
    } finally {
      reg.close();
    }
  });

  test('getForAgent(agentId) → shared + own per-agent only', () => {
    plant(userDir, 'shared', 'a');
    plantAgent(userAgentsDir, 'developer', 'dev-tool', 'b');
    plantAgent(userAgentsDir, 'reviewer', 'rev-tool', 'c');

    const reg = build();
    try {
      const dev = reg.getForAgent('developer');
      expect(dev.map((s) => s.name).sort()).toEqual(['dev-tool', 'shared']);
      const rev = reg.getForAgent('reviewer');
      expect(rev.map((s) => s.name).sort()).toEqual(['rev-tool', 'shared']);
    } finally {
      reg.close();
    }
  });

  test('getByName prefers shared-scope when multiple variants exist', () => {
    plant(userDir, 'review', 'shared user');
    plantAgent(userAgentsDir, 'developer', 'review', 'developer review');

    const reg = build();
    try {
      const found = reg.getByName('review');
      expect(found?.scope).toBe('user');
    } finally {
      reg.close();
    }
  });

  test('getByName falls through to per-agent when no shared variant', () => {
    plantAgent(userAgentsDir, 'developer', 'review', 'developer review');

    const reg = build();
    try {
      const found = reg.getByName('review');
      expect(found?.scope).toBe('user-agent');
      expect(found?.agentId).toBe('developer');
    } finally {
      reg.close();
    }
  });
});
