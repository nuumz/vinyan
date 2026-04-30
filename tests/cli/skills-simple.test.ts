/**
 * Hybrid skill redesign — `vinyan skills new|list|show|search|edit|remove|mode` CLI.
 *
 * Targets the project-scope path so tests can use a single temp workspace
 * without leaking into the user's real `~/.vinyan/skills/`.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureStarterPack, runSkillsSimpleCommand } from '../../src/cli/skills-simple.ts';

let workspace: string;
let originalLog: typeof console.log;
let originalWarn: typeof console.warn;
let logged: string[];
let warned: string[];

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'skills-cli-'));
  logged = [];
  warned = [];
  originalLog = console.log;
  originalWarn = console.warn;
  console.log = (...args: unknown[]) => {
    logged.push(args.map(String).join(' '));
  };
  console.warn = (...args: unknown[]) => {
    warned.push(args.map(String).join(' '));
  };
  // Make sure tests never spawn a real $EDITOR.
  delete process.env.EDITOR;
  delete process.env.VISUAL;
});

afterEach(() => {
  console.log = originalLog;
  console.warn = originalWarn;
  rmSync(workspace, { recursive: true, force: true });
});

function plant(name: string, frontmatter: string, body = 'body content'): void {
  const dir = join(workspace, '.vinyan', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}\n`);
}

describe('skills new', () => {
  test('creates SKILL.md with name + description', async () => {
    await runSkillsSimpleCommand(
      ['new', 'my-skill', '--description=Test description', '--no-edit'],
      { workspace },
    );
    const path = join(workspace, '.vinyan', 'skills', 'my-skill', 'SKILL.md');
    expect(existsSync(path)).toBe(true);
    const content = readFileSync(path, 'utf-8');
    expect(content).toContain('name: my-skill');
    expect(content).toContain('description: Test description');
  });

  test('refuses to overwrite an existing skill', async () => {
    plant('existing', 'name: existing\ndescription: keep me');
    await expect(
      runSkillsSimpleCommand(['new', 'existing', '--no-edit'], { workspace }),
    ).rejects.toThrow(/already exists/);
  });

  test('rejects invalid skill names', async () => {
    await expect(
      runSkillsSimpleCommand(['new', 'Bad Name!', '--no-edit'], { workspace }),
    ).rejects.toThrow(/Invalid skill name/);
  });

  test('--scope=user routes to ~/.vinyan/skills/ (we just verify error path here)', async () => {
    // We don't actually write to the user home in tests. Just verify the
    // scope flag is parsed correctly by checking that an invalid scope
    // throws.
    await expect(
      runSkillsSimpleCommand(['new', 'whatever', '--scope=other', '--no-edit'], { workspace }),
    ).rejects.toThrow(/Invalid scope/);
  });
});

describe('skills list', () => {
  test('shows all loaded skills', async () => {
    plant('a', 'name: a\ndescription: alpha');
    plant('b', 'name: b\ndescription: beta');

    await runSkillsSimpleCommand(['list'], { workspace });
    const output = logged.join('\n');
    expect(output).toContain('NAME');
    expect(output).toContain('a');
    expect(output).toContain('alpha');
    expect(output).toContain('b');
    expect(output).toContain('beta');
  });

  test('empty workspace → friendly empty message', async () => {
    await runSkillsSimpleCommand(['list'], { workspace });
    const output = logged.join('\n');
    expect(output).toContain('No simple skills found');
  });

  test('--scope=project filters', async () => {
    plant('project-only', 'name: project-only\ndescription: in proj');
    await runSkillsSimpleCommand(['list', '--scope=project'], { workspace });
    expect(logged.join('\n')).toContain('project-only');
  });
});

describe('skills show', () => {
  test('renders body for a known skill', async () => {
    plant('hello', 'name: hello\ndescription: greeting', 'GREETING-BODY-LINE');
    await runSkillsSimpleCommand(['show', 'hello'], { workspace });
    const output = logged.join('\n');
    expect(output).toContain('hello');
    expect(output).toContain('greeting');
    expect(output).toContain('GREETING-BODY-LINE');
  });

  test('throws when skill missing', async () => {
    await expect(runSkillsSimpleCommand(['show', 'ghost'], { workspace })).rejects.toThrow(/not found/);
  });

  test('requires a name', async () => {
    await expect(runSkillsSimpleCommand(['show'], { workspace })).rejects.toThrow(/Usage/);
  });
});

describe('skills search', () => {
  test('returns matches above threshold ordered by score', async () => {
    plant('code-review', 'name: code-review\ndescription: review code for bugs');
    plant('debug-trace', 'name: debug-trace\ndescription: walk through stack traces');

    await runSkillsSimpleCommand(['search', 'review', 'code'], { workspace });
    const output = logged.join('\n');
    expect(output).toContain('code-review');
    // debug-trace should rank lower or be excluded
    expect(output.indexOf('code-review')).toBeLessThan(
      output.indexOf('debug-trace') > -1 ? output.indexOf('debug-trace') : Infinity,
    );
  });

  test('empty registry → friendly message', async () => {
    await runSkillsSimpleCommand(['search', 'anything'], { workspace });
    expect(logged.join('\n')).toContain('No simple skills available');
  });

  test('rejects empty query', async () => {
    plant('any', 'name: any\ndescription: x');
    await expect(runSkillsSimpleCommand(['search'], { workspace })).rejects.toThrow(/Usage/);
  });
});

describe('skills remove', () => {
  test('--force deletes the skill dir', async () => {
    plant('to-remove', 'name: to-remove\ndescription: gone');
    expect(existsSync(join(workspace, '.vinyan', 'skills', 'to-remove'))).toBe(true);

    await runSkillsSimpleCommand(['remove', 'to-remove', '--force'], { workspace });
    expect(existsSync(join(workspace, '.vinyan', 'skills', 'to-remove'))).toBe(false);
  });

  test('without --force prints confirmation note and does not delete', async () => {
    plant('keep-me', 'name: keep-me\ndescription: alive');
    await runSkillsSimpleCommand(['remove', 'keep-me'], { workspace });
    expect(logged.join('\n')).toContain('--force to confirm');
    expect(existsSync(join(workspace, '.vinyan', 'skills', 'keep-me'))).toBe(true);
  });

  test('throws when skill missing', async () => {
    await expect(
      runSkillsSimpleCommand(['remove', 'ghost', '--force'], { workspace }),
    ).rejects.toThrow(/not found/);
  });
});

describe('skills mode', () => {
  test('sets mode in vinyan.json', async () => {
    writeFileSync(join(workspace, 'vinyan.json'), `${JSON.stringify({ version: 1, oracles: {} }, null, 2)}\n`);
    await runSkillsSimpleCommand(['mode', 'epistemic'], { workspace });

    const cfg = JSON.parse(readFileSync(join(workspace, 'vinyan.json'), 'utf-8')) as {
      skills?: { mode?: string };
    };
    expect(cfg.skills?.mode).toBe('epistemic');
  });

  test('rejects invalid mode', async () => {
    await expect(runSkillsSimpleCommand(['mode', 'turbo'], { workspace })).rejects.toThrow(/Invalid mode/);
  });

  test('reads current mode when no arg', async () => {
    writeFileSync(
      join(workspace, 'vinyan.json'),
      `${JSON.stringify({ version: 1, oracles: {}, skills: { mode: 'both' } }, null, 2)}\n`,
    );
    await runSkillsSimpleCommand(['mode'], { workspace });
    expect(logged.join('\n')).toContain('mode: both');
  });
});

describe('ensureStarterPack', () => {
  let templatesRoot: string;
  let userDir: string;

  beforeEach(() => {
    templatesRoot = mkdtempSync(join(tmpdir(), 'starter-templates-'));
    userDir = mkdtempSync(join(tmpdir(), 'starter-user-'));
    rmSync(userDir, { recursive: true, force: true });
    // Plant only the well-known starter names so the loader picks them up.
    for (const name of ['code-review', 'debug-trace', 'git-commit-message', 'unit-test-plan']) {
      mkdirSync(join(templatesRoot, name), { recursive: true });
      writeFileSync(
        join(templatesRoot, name, 'SKILL.md'),
        `---\nname: ${name}\ndescription: starter ${name}\n---\nbody\n`,
      );
    }
  });

  afterEach(() => {
    rmSync(templatesRoot, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  });

  test('seeds empty user dir', () => {
    const result = ensureStarterPack(templatesRoot, userDir);
    expect(result.copied.length).toBe(4);
    for (const name of ['code-review', 'debug-trace', 'git-commit-message', 'unit-test-plan']) {
      expect(existsSync(join(userDir, name, 'SKILL.md'))).toBe(true);
    }
  });

  test('refuses to overwrite a populated user dir', () => {
    mkdirSync(join(userDir, 'existing'), { recursive: true });
    writeFileSync(join(userDir, 'existing', 'SKILL.md'), '---\nname: existing\n---\nbody\n');

    const result = ensureStarterPack(templatesRoot, userDir);
    expect(result.copied).toEqual([]);
    expect(result.reason).toContain('already populated');
  });

  test('missing templates dir → empty copy, reason set', () => {
    const result = ensureStarterPack(join(templatesRoot, 'nope'), userDir);
    expect(result.copied).toEqual([]);
    expect(result.reason).toContain('templates dir missing');
  });
});
