/**
 * Per-agent CLI tests — `vinyan skills new/list/show/remove --agent=<id>`.
 *
 * Tests the project-scope flow only so they don't pollute the user home dir.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSkillsSimpleCommand } from '../../src/cli/skills-simple.ts';

let workspace: string;
let originalLog: typeof console.log;
let originalWarn: typeof console.warn;
let logged: string[];

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'pa-cli-'));
  logged = [];
  originalLog = console.log;
  originalWarn = console.warn;
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };
  console.warn = () => {};
  delete process.env.EDITOR;
  delete process.env.VISUAL;
});

afterEach(() => {
  console.log = originalLog;
  console.warn = originalWarn;
  rmSync(workspace, { recursive: true, force: true });
});

function plantAgent(agentId: string, name: string, frontmatter: string, body = 'body'): void {
  const dir = join(workspace, '.vinyan', 'agents', agentId, 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}\n`);
}

describe('skills new --agent', () => {
  test('--agent=<id> --scope=project routes to project-agent dir', async () => {
    await runSkillsSimpleCommand(
      ['new', 'ts-debug', '--agent=developer', '--scope=project', '--description=TS debug', '--no-edit'],
      { workspace },
    );
    const expectedPath = join(workspace, '.vinyan', 'agents', 'developer', 'skills', 'ts-debug', 'SKILL.md');
    expect(existsSync(expectedPath)).toBe(true);
    const content = readFileSync(expectedPath, 'utf-8');
    expect(content).toContain('name: ts-debug');
    expect(content).toContain('description: TS debug');
  });

  test('--agent=<id> rejects invalid agent ids', async () => {
    await expect(
      runSkillsSimpleCommand(['new', 'thing', '--agent=Bad ID!', '--no-edit'], { workspace }),
    ).rejects.toThrow(/Invalid agent id/);
  });

  test('per-agent skill at same name as shared coexists', async () => {
    // Plant a project-shared first.
    mkdirSync(join(workspace, '.vinyan', 'skills', 'review'), { recursive: true });
    writeFileSync(
      join(workspace, '.vinyan', 'skills', 'review', 'SKILL.md'),
      `---\nname: review\ndescription: shared\n---\nbody\n`,
    );
    // Add a per-agent variant.
    await runSkillsSimpleCommand(
      ['new', 'review', '--agent=developer', '--scope=project', '--description=dev variant', '--no-edit'],
      { workspace },
    );
    const projectAgentPath = join(workspace, '.vinyan', 'agents', 'developer', 'skills', 'review', 'SKILL.md');
    expect(existsSync(projectAgentPath)).toBe(true);
  });
});

describe('skills list --agent', () => {
  test('--agent=<id> filters to shared + that agent', async () => {
    plantAgent('developer', 'dev-tool', 'name: dev-tool\ndescription: dev only');
    plantAgent('reviewer', 'rev-tool', 'name: rev-tool\ndescription: rev only');
    mkdirSync(join(workspace, '.vinyan', 'skills', 'public'), { recursive: true });
    writeFileSync(
      join(workspace, '.vinyan', 'skills', 'public', 'SKILL.md'),
      `---\nname: public\ndescription: public\n---\nbody\n`,
    );

    await runSkillsSimpleCommand(['list', '--agent=developer'], { workspace });
    const out = logged.join('\n');
    expect(out).toContain('dev-tool');
    expect(out).toContain('public');
    expect(out).not.toContain('rev-tool');
  });

  test('without --agent → shared scopes only (legacy behaviour)', async () => {
    plantAgent('developer', 'private-tool', 'name: private-tool\ndescription: private');
    mkdirSync(join(workspace, '.vinyan', 'skills', 'public'), { recursive: true });
    writeFileSync(
      join(workspace, '.vinyan', 'skills', 'public', 'SKILL.md'),
      `---\nname: public\ndescription: x\n---\nbody\n`,
    );

    await runSkillsSimpleCommand(['list'], { workspace });
    const out = logged.join('\n');
    expect(out).toContain('public');
    expect(out).not.toContain('private-tool');
  });

  test('--agent=ALL shows everything', async () => {
    plantAgent('developer', 'a', 'name: a\ndescription: a');
    plantAgent('reviewer', 'b', 'name: b\ndescription: b');

    await runSkillsSimpleCommand(['list', '--agent=ALL'], { workspace });
    const out = logged.join('\n');
    expect(out).toContain('a');
    expect(out).toContain('b');
  });
});

describe('skills show / remove --agent', () => {
  test('show --agent=<id> resolves the per-agent variant', async () => {
    plantAgent('developer', 'review', 'name: review\ndescription: dev review', 'DEV BODY');
    mkdirSync(join(workspace, '.vinyan', 'skills', 'review'), { recursive: true });
    writeFileSync(
      join(workspace, '.vinyan', 'skills', 'review', 'SKILL.md'),
      `---\nname: review\ndescription: shared review\n---\nSHARED BODY\n`,
    );

    await runSkillsSimpleCommand(['show', 'review', '--agent=developer'], { workspace });
    const out = logged.join('\n');
    expect(out).toContain('DEV BODY');
    expect(out).toContain('agent: developer');
    expect(out).not.toContain('SHARED BODY');
  });

  test('remove --agent=<id> --force deletes only that agent variant', async () => {
    plantAgent('developer', 'tool', 'name: tool\ndescription: dev tool');
    plantAgent('reviewer', 'tool', 'name: tool\ndescription: rev tool');

    await runSkillsSimpleCommand(['remove', 'tool', '--agent=developer', '--force'], { workspace });
    expect(existsSync(join(workspace, '.vinyan', 'agents', 'developer', 'skills', 'tool'))).toBe(false);
    expect(existsSync(join(workspace, '.vinyan', 'agents', 'reviewer', 'skills', 'tool'))).toBe(true);
  });
});
