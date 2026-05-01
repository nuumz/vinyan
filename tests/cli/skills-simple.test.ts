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

import {
  ensureSystemSkillPack,
  installExampleSkills,
  installSystemSkills,
  pruneRetiredStarters,
  RETIRED_STARTER_NAMES,
  runSkillsSimpleCommand,
  SYSTEM_SKILL_NAMES,
} from '../../src/cli/skills-simple.ts';

let workspace: string;
let fakeHome: string;
let originalHome: string | undefined;
let originalLog: typeof console.log;
let originalWarn: typeof console.warn;
let logged: string[];
let warned: string[];

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'skills-cli-'));
  // Isolate $HOME so loadSimpleSkills' user-scope scan does not leak the
  // developer's real ~/.vinyan/skills/ into the test (or vice versa). Every
  // test in this file starts with an empty user-global scope unless it
  // explicitly plants something there.
  fakeHome = mkdtempSync(join(tmpdir(), 'skills-cli-home-'));
  originalHome = process.env.HOME;
  process.env.HOME = fakeHome;
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
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  rmSync(workspace, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
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
      { workspace, userSkillsDir: fakeHome },
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
      runSkillsSimpleCommand(['new', 'existing', '--no-edit'], { workspace, userSkillsDir: fakeHome }),
    ).rejects.toThrow(/already exists/);
  });

  test('rejects invalid skill names', async () => {
    await expect(
      runSkillsSimpleCommand(['new', 'Bad Name!', '--no-edit'], { workspace, userSkillsDir: fakeHome }),
    ).rejects.toThrow(/Invalid skill name/);
  });

  test('--scope=user routes to ~/.vinyan/skills/ (we just verify error path here)', async () => {
    // We don't actually write to the user home in tests. Just verify the
    // scope flag is parsed correctly by checking that an invalid scope
    // throws.
    await expect(
      runSkillsSimpleCommand(['new', 'whatever', '--scope=other', '--no-edit'], { workspace, userSkillsDir: fakeHome }),
    ).rejects.toThrow(/Invalid scope/);
  });
});

describe('skills list', () => {
  test('shows all loaded skills', async () => {
    plant('a', 'name: a\ndescription: alpha');
    plant('b', 'name: b\ndescription: beta');

    await runSkillsSimpleCommand(['list'], { workspace, userSkillsDir: fakeHome });
    const output = logged.join('\n');
    expect(output).toContain('NAME');
    expect(output).toContain('a');
    expect(output).toContain('alpha');
    expect(output).toContain('b');
    expect(output).toContain('beta');
  });

  test('empty workspace → friendly empty message', async () => {
    await runSkillsSimpleCommand(['list'], { workspace, userSkillsDir: fakeHome });
    const output = logged.join('\n');
    expect(output).toContain('No simple skills found');
  });

  test('--scope=project filters', async () => {
    plant('project-only', 'name: project-only\ndescription: in proj');
    await runSkillsSimpleCommand(['list', '--scope=project'], { workspace, userSkillsDir: fakeHome });
    expect(logged.join('\n')).toContain('project-only');
  });
});

describe('skills show', () => {
  test('renders body for a known skill', async () => {
    plant('hello', 'name: hello\ndescription: greeting', 'GREETING-BODY-LINE');
    await runSkillsSimpleCommand(['show', 'hello'], { workspace, userSkillsDir: fakeHome });
    const output = logged.join('\n');
    expect(output).toContain('hello');
    expect(output).toContain('greeting');
    expect(output).toContain('GREETING-BODY-LINE');
  });

  test('throws when skill missing', async () => {
    await expect(runSkillsSimpleCommand(['show', 'ghost'], { workspace, userSkillsDir: fakeHome })).rejects.toThrow(/not found/);
  });

  test('requires a name', async () => {
    await expect(runSkillsSimpleCommand(['show'], { workspace, userSkillsDir: fakeHome })).rejects.toThrow(/Usage/);
  });
});

describe('skills search', () => {
  test('returns matches above threshold ordered by score', async () => {
    plant('code-review', 'name: code-review\ndescription: review code for bugs');
    plant('debug-trace', 'name: debug-trace\ndescription: walk through stack traces');

    await runSkillsSimpleCommand(['search', 'review', 'code'], { workspace, userSkillsDir: fakeHome });
    const output = logged.join('\n');
    expect(output).toContain('code-review');
    // debug-trace should rank lower or be excluded
    expect(output.indexOf('code-review')).toBeLessThan(
      output.indexOf('debug-trace') > -1 ? output.indexOf('debug-trace') : Infinity,
    );
  });

  test('empty registry → friendly message', async () => {
    await runSkillsSimpleCommand(['search', 'anything'], { workspace, userSkillsDir: fakeHome });
    expect(logged.join('\n')).toContain('No simple skills available');
  });

  test('rejects empty query', async () => {
    plant('any', 'name: any\ndescription: x');
    await expect(runSkillsSimpleCommand(['search'], { workspace, userSkillsDir: fakeHome })).rejects.toThrow(/Usage/);
  });
});

describe('skills remove', () => {
  test('--force deletes the skill dir', async () => {
    plant('to-remove', 'name: to-remove\ndescription: gone');
    expect(existsSync(join(workspace, '.vinyan', 'skills', 'to-remove'))).toBe(true);

    await runSkillsSimpleCommand(['remove', 'to-remove', '--force'], { workspace, userSkillsDir: fakeHome });
    expect(existsSync(join(workspace, '.vinyan', 'skills', 'to-remove'))).toBe(false);
  });

  test('without --force prints confirmation note and does not delete', async () => {
    plant('keep-me', 'name: keep-me\ndescription: alive');
    await runSkillsSimpleCommand(['remove', 'keep-me'], { workspace, userSkillsDir: fakeHome });
    expect(logged.join('\n')).toContain('--force to confirm');
    expect(existsSync(join(workspace, '.vinyan', 'skills', 'keep-me'))).toBe(true);
  });

  test('throws when skill missing', async () => {
    await expect(
      runSkillsSimpleCommand(['remove', 'ghost', '--force'], { workspace, userSkillsDir: fakeHome }),
    ).rejects.toThrow(/not found/);
  });
});

describe('skills mode', () => {
  test('sets mode in vinyan.json', async () => {
    writeFileSync(join(workspace, 'vinyan.json'), `${JSON.stringify({ version: 1, oracles: {} }, null, 2)}\n`);
    await runSkillsSimpleCommand(['mode', 'epistemic'], { workspace, userSkillsDir: fakeHome });

    const cfg = JSON.parse(readFileSync(join(workspace, 'vinyan.json'), 'utf-8')) as {
      skills?: { mode?: string };
    };
    expect(cfg.skills?.mode).toBe('epistemic');
  });

  test('rejects invalid mode', async () => {
    await expect(runSkillsSimpleCommand(['mode', 'turbo'], { workspace, userSkillsDir: fakeHome })).rejects.toThrow(/Invalid mode/);
  });

  test('reads current mode when no arg', async () => {
    writeFileSync(
      join(workspace, 'vinyan.json'),
      `${JSON.stringify({ version: 1, oracles: {}, skills: { mode: 'both' } }, null, 2)}\n`,
    );
    await runSkillsSimpleCommand(['mode'], { workspace, userSkillsDir: fakeHome });
    expect(logged.join('\n')).toContain('mode: both');
  });
});

describe('ensureSystemSkillPack', () => {
  let templatesRoot: string;
  let userDir: string;

  beforeEach(() => {
    templatesRoot = mkdtempSync(join(tmpdir(), 'system-templates-'));
    userDir = mkdtempSync(join(tmpdir(), 'system-user-'));
    rmSync(userDir, { recursive: true, force: true });
    // Plant the 14 system-skill names so the seeder picks them up.
    for (const name of SYSTEM_SKILL_NAMES) {
      mkdirSync(join(templatesRoot, name), { recursive: true });
      writeFileSync(
        join(templatesRoot, name, 'SKILL.md'),
        `---\nname: ${name}\ndescription: system ${name}\n---\nbody\n`,
      );
    }
  });

  afterEach(() => {
    rmSync(templatesRoot, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  });

  test('seeds empty user dir with all 14 system skills', () => {
    const result = ensureSystemSkillPack(templatesRoot, userDir);
    expect(result.copied.length).toBe(SYSTEM_SKILL_NAMES.length);
    for (const name of SYSTEM_SKILL_NAMES) {
      expect(existsSync(join(userDir, name, 'SKILL.md'))).toBe(true);
    }
  });

  test('does not seed any retired starter names', () => {
    ensureSystemSkillPack(templatesRoot, userDir);
    for (const name of RETIRED_STARTER_NAMES) {
      expect(existsSync(join(userDir, name, 'SKILL.md'))).toBe(false);
    }
  });

  test('refuses to overwrite a populated user dir', () => {
    mkdirSync(join(userDir, 'existing'), { recursive: true });
    writeFileSync(join(userDir, 'existing', 'SKILL.md'), '---\nname: existing\n---\nbody\n');

    const result = ensureSystemSkillPack(templatesRoot, userDir);
    expect(result.copied).toEqual([]);
    expect(result.reason).toContain('already populated');
  });

  test('missing templates dir → empty copy, reason set', () => {
    const result = ensureSystemSkillPack(join(templatesRoot, 'nope'), userDir);
    expect(result.copied).toEqual([]);
    expect(result.reason).toContain('templates dir missing');
  });
});

describe('installSystemSkills', () => {
  let templatesRoot: string;
  let userDir: string;

  beforeEach(() => {
    templatesRoot = mkdtempSync(join(tmpdir(), 'install-system-templates-'));
    userDir = mkdtempSync(join(tmpdir(), 'install-system-user-'));
    for (const name of SYSTEM_SKILL_NAMES) {
      mkdirSync(join(templatesRoot, name), { recursive: true });
      writeFileSync(
        join(templatesRoot, name, 'SKILL.md'),
        `---\nname: ${name}\ndescription: system ${name}\n---\nbody for ${name}\n`,
      );
    }
  });

  afterEach(() => {
    rmSync(templatesRoot, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  });

  test('copies all 14 into a fresh user dir', () => {
    const result = installSystemSkills(templatesRoot, userDir);
    expect(result.copied.length).toBe(SYSTEM_SKILL_NAMES.length);
    expect(result.skipped.length).toBe(0);
  });

  test('skips names that already exist on disk (preserves user customisations)', () => {
    // Pre-plant a user-customised version of one system skill.
    const target = SYSTEM_SKILL_NAMES[0]!;
    mkdirSync(join(userDir, target), { recursive: true });
    writeFileSync(
      join(userDir, target, 'SKILL.md'),
      '---\nname: ' + target + '\ndescription: my custom version\n---\nMY BODY\n',
    );

    const result = installSystemSkills(templatesRoot, userDir);
    expect(result.copied).not.toContain(target);
    expect(result.skipped.find((s) => s.name === target)?.reason).toContain('already exists');

    // Verify the user's content is untouched.
    const content = readFileSync(join(userDir, target, 'SKILL.md'), 'utf-8');
    expect(content).toContain('MY BODY');
  });

  test('--force overwrites existing same-name skills', () => {
    const target = SYSTEM_SKILL_NAMES[0]!;
    mkdirSync(join(userDir, target), { recursive: true });
    writeFileSync(join(userDir, target, 'SKILL.md'), '---\nname: ' + target + '\n---\nold\n');

    const result = installSystemSkills(templatesRoot, userDir, { force: true });
    expect(result.copied).toContain(target);

    const content = readFileSync(join(userDir, target, 'SKILL.md'), 'utf-8');
    expect(content).toContain('body for ' + target);
  });

  test('idempotent: running twice produces no diff after the first run', () => {
    installSystemSkills(templatesRoot, userDir);
    const second = installSystemSkills(templatesRoot, userDir);
    expect(second.copied).toEqual([]);
    expect(second.skipped.every((s) => s.reason.includes('already exists'))).toBe(true);
  });
});

describe('installExampleSkills', () => {
  let examplesRoot: string;
  let userDir: string;

  beforeEach(() => {
    examplesRoot = mkdtempSync(join(tmpdir(), 'install-examples-templates-'));
    userDir = mkdtempSync(join(tmpdir(), 'install-examples-user-'));
    for (const name of RETIRED_STARTER_NAMES) {
      mkdirSync(join(examplesRoot, name), { recursive: true });
      writeFileSync(
        join(examplesRoot, name, 'SKILL.md'),
        `---\nname: ${name}\ndescription: example ${name}\n---\nbody for ${name}\n`,
      );
    }
  });

  afterEach(() => {
    rmSync(examplesRoot, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  });

  test('opt-in install of the 4 retired starters', () => {
    const result = installExampleSkills(examplesRoot, userDir);
    expect(result.copied.length).toBe(RETIRED_STARTER_NAMES.length);
    for (const name of RETIRED_STARTER_NAMES) {
      expect(existsSync(join(userDir, name, 'SKILL.md'))).toBe(true);
    }
  });

  test('does not auto-install system skills', () => {
    installExampleSkills(examplesRoot, userDir);
    for (const name of SYSTEM_SKILL_NAMES) {
      expect(existsSync(join(userDir, name, 'SKILL.md'))).toBe(false);
    }
  });
});

describe('pruneRetiredStarters', () => {
  let examplesRoot: string;
  let userDir: string;

  beforeEach(() => {
    examplesRoot = mkdtempSync(join(tmpdir(), 'prune-examples-'));
    userDir = mkdtempSync(join(tmpdir(), 'prune-user-'));
    for (const name of RETIRED_STARTER_NAMES) {
      mkdirSync(join(examplesRoot, name), { recursive: true });
      writeFileSync(
        join(examplesRoot, name, 'SKILL.md'),
        `---\nname: ${name}\n---\nbundled body for ${name}\n`,
      );
    }
  });

  afterEach(() => {
    rmSync(examplesRoot, { recursive: true, force: true });
    rmSync(userDir, { recursive: true, force: true });
  });

  test('removes unmodified retired starters when content matches the bundled exemplar', () => {
    // Copy the bundled exemplar into the user dir as if `vinyan init` had
    // seeded the old pack.
    for (const name of RETIRED_STARTER_NAMES) {
      mkdirSync(join(userDir, name), { recursive: true });
      writeFileSync(
        join(userDir, name, 'SKILL.md'),
        readFileSync(join(examplesRoot, name, 'SKILL.md'), 'utf-8'),
      );
    }

    const result = pruneRetiredStarters(examplesRoot, userDir);
    expect(result.removed).toEqual([...RETIRED_STARTER_NAMES]);
    for (const name of RETIRED_STARTER_NAMES) {
      expect(existsSync(join(userDir, name, 'SKILL.md'))).toBe(false);
    }
  });

  test('keeps user-customised copies (content differs from exemplar)', () => {
    const target = RETIRED_STARTER_NAMES[0]!;
    mkdirSync(join(userDir, target), { recursive: true });
    writeFileSync(
      join(userDir, target, 'SKILL.md'),
      '---\nname: ' + target + '\n---\nMY CUSTOM BODY\n',
    );

    const result = pruneRetiredStarters(examplesRoot, userDir);
    expect(result.removed).not.toContain(target);
    const kept = result.skipped.find((s) => s.name === target);
    expect(kept?.reason).toContain('user-customised');
    expect(existsSync(join(userDir, target, 'SKILL.md'))).toBe(true);
  });

  test('skips names not present on disk (no-op for missing entries)', () => {
    const result = pruneRetiredStarters(examplesRoot, userDir);
    expect(result.removed).toEqual([]);
    expect(result.skipped.every((s) => s.reason === 'not present')).toBe(true);
  });
});

describe('skills install-system CLI', () => {
  // Drives runInstallSystem through the CLI surface with a stubbed
  // userSkillsDir; verifies the CLI plumbing (stdout shape, --force, prune)
  // beyond what installSystemSkills itself covers.
  let userDir: string;

  beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), 'cli-install-system-'));
    rmSync(userDir, { recursive: true, force: true });
  });

  afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
  });

  test('reports installed names from the bundled templates dir', async () => {
    await runSkillsSimpleCommand(['install-system', '--user-dir', userDir], { workspace, userSkillsDir: fakeHome });
    const output = logged.join('\n');
    expect(output).toContain('System-skill install');
    // At least one representative system skill mentioned in stdout.
    expect(output).toContain('workflow-intake');
    // Files actually landed.
    expect(existsSync(join(userDir, 'workflow-intake', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(userDir, 'planning-contract', 'SKILL.md'))).toBe(true);
  });

  test('idempotent: second run reports already-present and copies nothing new', async () => {
    await runSkillsSimpleCommand(['install-system', '--user-dir', userDir], { workspace, userSkillsDir: fakeHome });
    logged.length = 0;
    await runSkillsSimpleCommand(['install-system', '--user-dir', userDir], { workspace, userSkillsDir: fakeHome });
    const output = logged.join('\n');
    expect(output).toContain('All system skills already present');
  });
});
