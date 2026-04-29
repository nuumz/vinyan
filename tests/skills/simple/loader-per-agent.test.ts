/**
 * Per-agent simple-skill loader tests.
 *
 * Layout under test:
 *   <user-root>/<name>/SKILL.md                       — user shared
 *   <user-agents-root>/<agent>/skills/<name>/SKILL.md — user-agent
 *   <project-root>/<name>/SKILL.md                    — project shared
 *   <project-agents-root>/<agent>/skills/<name>/SKILL.md — project-agent
 *
 * Verifies:
 *   - Each scope reachable via the appropriate dir
 *   - Per-agent skills carry the right `agentId` field
 *   - filterSkillsForAgent enforces visibility (X never sees Y's skills)
 *   - Precedence within visible set: project-agent > project > user-agent > user
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  filterSkillsForAgent,
  loadSimpleSkills,
} from '../../../src/skills/simple/loader.ts';

let userDir: string;
let userAgentsDir: string;
let projectDir: string;
let projectAgentsDir: string;
let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'pa-ws-'));
  userDir = mkdtempSync(join(tmpdir(), 'pa-user-shared-'));
  userAgentsDir = mkdtempSync(join(tmpdir(), 'pa-user-agents-'));
  projectDir = mkdtempSync(join(tmpdir(), 'pa-proj-shared-'));
  projectAgentsDir = mkdtempSync(join(tmpdir(), 'pa-proj-agents-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(userDir, { recursive: true, force: true });
  rmSync(userAgentsDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
  rmSync(projectAgentsDir, { recursive: true, force: true });
});

function plant(rootDir: string, name: string, description: string, body = 'body content'): void {
  const dir = join(rootDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
}

function plantAgent(agentsRoot: string, agentId: string, name: string, description: string, body = 'body'): void {
  const dir = join(agentsRoot, agentId, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
}

function load() {
  return loadSimpleSkills({
    workspace,
    userSkillsDir: userDir,
    projectSkillsDir: projectDir,
    userAgentsDir,
    projectAgentsDir,
  });
}

describe('loadSimpleSkills — per-agent scopes', () => {
  test('user-agent skill carries scope=user-agent + agentId', () => {
    plantAgent(userAgentsDir, 'developer', 'ts-debug', 'TS-specific debugging');

    const result = load();
    expect(result.skills.length).toBe(1);
    expect(result.skills[0]?.scope).toBe('user-agent');
    expect(result.skills[0]?.agentId).toBe('developer');
    expect(result.skills[0]?.name).toBe('ts-debug');
  });

  test('project-agent skill carries scope=project-agent + agentId', () => {
    plantAgent(projectAgentsDir, 'reviewer', 'project-checklist', 'project-specific review');

    const result = load();
    expect(result.skills.length).toBe(1);
    expect(result.skills[0]?.scope).toBe('project-agent');
    expect(result.skills[0]?.agentId).toBe('reviewer');
  });

  test('all 4 scopes coexist for distinct skill names', () => {
    plant(userDir, 'shared-user', 'a');
    plant(projectDir, 'shared-proj', 'b');
    plantAgent(userAgentsDir, 'developer', 'dev-tool', 'c');
    plantAgent(projectAgentsDir, 'reviewer', 'rev-tool', 'd');

    const result = load();
    expect(result.skills.length).toBe(4);
    const byScope = new Map(result.skills.map((s) => [s.scope, s]));
    expect(byScope.get('user')?.name).toBe('shared-user');
    expect(byScope.get('project')?.name).toBe('shared-proj');
    expect(byScope.get('user-agent')?.agentId).toBe('developer');
    expect(byScope.get('project-agent')?.agentId).toBe('reviewer');
  });

  test('two agents own a skill of the same name → both kept (separated by agentId)', () => {
    plantAgent(userAgentsDir, 'developer', 'review', 'dev review');
    plantAgent(userAgentsDir, 'reviewer', 'review', 'reviewer review');

    const result = load();
    expect(result.skills.length).toBe(2);
    const agentIds = new Set(result.skills.map((s) => s.agentId));
    expect(agentIds).toEqual(new Set(['developer', 'reviewer']));
  });

  test('agent dir without skills/ subdir is silently skipped', () => {
    mkdirSync(join(userAgentsDir, 'orphan'), { recursive: true });
    plantAgent(userAgentsDir, 'developer', 'real', 'present');

    const result = load();
    expect(result.skills.length).toBe(1);
    expect(result.skills[0]?.agentId).toBe('developer');
  });
});

describe('filterSkillsForAgent — visibility', () => {
  test('without agentId → only shared-scope skills', () => {
    plant(userDir, 'shared', 'public');
    plantAgent(userAgentsDir, 'developer', 'dev-only', 'private');

    const result = load();
    const visible = filterSkillsForAgent(result.skills, undefined);
    expect(visible.length).toBe(1);
    expect(visible[0]?.name).toBe('shared');
  });

  test('with agentId → shared + own per-agent only', () => {
    plant(userDir, 'shared', 'public');
    plantAgent(userAgentsDir, 'developer', 'dev-only', 'dev private');
    plantAgent(userAgentsDir, 'reviewer', 'rev-only', 'rev private');

    const result = load();
    const devVisible = filterSkillsForAgent(result.skills, 'developer');
    expect(devVisible.map((s) => s.name).sort()).toEqual(['dev-only', 'shared']);
    const revVisible = filterSkillsForAgent(result.skills, 'reviewer');
    expect(revVisible.map((s) => s.name).sort()).toEqual(['rev-only', 'shared']);
  });

  test('agent X never sees agent Y per-agent skill (privacy isolation)', () => {
    plantAgent(userAgentsDir, 'developer', 'private-tool', 'developer only');

    const result = load();
    const reviewerView = filterSkillsForAgent(result.skills, 'reviewer');
    expect(reviewerView.find((s) => s.name === 'private-tool')).toBeUndefined();
  });

  test('precedence: project-agent > project > user-agent > user', () => {
    plant(userDir, 'code-review', 'user shared');
    plantAgent(userAgentsDir, 'developer', 'code-review', 'user-agent variant');
    plant(projectDir, 'code-review', 'project shared');
    plantAgent(projectAgentsDir, 'developer', 'code-review', 'project-agent variant');

    const result = load();
    const view = filterSkillsForAgent(result.skills, 'developer');
    expect(view.length).toBe(1);
    expect(view[0]?.scope).toBe('project-agent');
    expect(view[0]?.description).toBe('project-agent variant');
  });

  test('precedence: with no project-agent, project shared wins over user-agent', () => {
    plantAgent(userAgentsDir, 'developer', 'code-review', 'user-agent');
    plant(projectDir, 'code-review', 'project shared');

    const result = load();
    const view = filterSkillsForAgent(result.skills, 'developer');
    expect(view.length).toBe(1);
    expect(view[0]?.scope).toBe('project');
    expect(view[0]?.description).toBe('project shared');
  });

  test('precedence: with neither project, user-agent wins over user shared', () => {
    plant(userDir, 'code-review', 'user shared');
    plantAgent(userAgentsDir, 'developer', 'code-review', 'user-agent');

    const result = load();
    const view = filterSkillsForAgent(result.skills, 'developer');
    expect(view.length).toBe(1);
    expect(view[0]?.scope).toBe('user-agent');
    expect(view[0]?.description).toBe('user-agent');
  });

  test('user-agent for X does not affect Y who only sees shared', () => {
    plant(userDir, 'code-review', 'user shared');
    plantAgent(userAgentsDir, 'developer', 'code-review', 'developer override');

    const result = load();
    const reviewerView = filterSkillsForAgent(result.skills, 'reviewer');
    expect(reviewerView[0]?.scope).toBe('user');
    expect(reviewerView[0]?.description).toBe('user shared');
  });
});
