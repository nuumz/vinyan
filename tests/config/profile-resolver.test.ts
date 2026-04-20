/**
 * Profile Resolver — behavior tests (W1 PR #1).
 *
 * Covers: priority of flag > env > default, name validation, path scoping,
 * legacy flat-layout backwards compatibility, directory creation with
 * mode 0700, and layered config merge semantics.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertValidProfileName,
  listProfiles,
  loadLayeredConfig,
  resolveProfile,
} from '../../src/config/profile-resolver.ts';

const EMPTY_ENV: NodeJS.ProcessEnv = {};

describe('resolveProfile — name resolution priority', () => {
  let vinyanHome: string;

  beforeEach(() => {
    vinyanHome = mkdtempSync(join(tmpdir(), 'vinyan-profile-'));
  });

  afterEach(() => {
    rmSync(vinyanHome, { recursive: true, force: true });
  });

  test('no flag, no env → returns default', () => {
    const result = resolveProfile({ vinyanHome, env: EMPTY_ENV });
    expect(result.name).toBe('default');
    expect(result.root.endsWith(join('profiles', 'default'))).toBe(true);
  });

  test('env var selects profile when flag absent', () => {
    const result = resolveProfile({ vinyanHome, env: { ['VINYAN_PROFILE']: 'work' } });
    expect(result.name).toBe('work');
    expect(result.root).toBe(join(vinyanHome, 'profiles', 'work'));
  });

  test('flag takes priority over env', () => {
    const result = resolveProfile({
      vinyanHome,
      flag: 'personal',
      env: { ['VINYAN_PROFILE']: 'work' },
    });
    expect(result.name).toBe('personal');
  });

  test('VINYAN_HOME env var is respected when vinyanHome opt omitted', () => {
    const result = resolveProfile({
      env: { ['VINYAN_HOME']: vinyanHome, ['VINYAN_PROFILE']: 'env-home' },
    });
    expect(result.vinyanHome).toBe(vinyanHome);
    expect(result.name).toBe('env-home');
  });
});

describe('resolveProfile — name validation', () => {
  test('rejects uppercase names', () => {
    expect(() => resolveProfile({ flag: 'Work', env: EMPTY_ENV })).toThrow(/Invalid profile name/);
  });

  test('rejects empty string flag falls through to default', () => {
    // Empty flag is treated as unset per pickProfileName contract.
    const result = resolveProfile({ flag: '', env: EMPTY_ENV, vinyanHome: mkdtempSync(join(tmpdir(), 'vp-')) });
    expect(result.name).toBe('default');
  });

  test('rejects path-traversal names', () => {
    expect(() => resolveProfile({ flag: '../etc', env: EMPTY_ENV })).toThrow();
    expect(() => resolveProfile({ flag: 'foo/bar', env: EMPTY_ENV })).toThrow();
  });

  test('rejects leading digit or dash', () => {
    expect(() => assertValidProfileName('1work')).toThrow();
    expect(() => assertValidProfileName('-work')).toThrow();
  });

  test('accepts valid kebab-case names', () => {
    expect(() => assertValidProfileName('default')).not.toThrow();
    expect(() => assertValidProfileName('work-main')).not.toThrow();
    expect(() => assertValidProfileName('a1')).not.toThrow();
  });
});

describe('resolveProfile — paths layout', () => {
  let vinyanHome: string;

  beforeEach(() => {
    vinyanHome = mkdtempSync(join(tmpdir(), 'vinyan-profile-'));
  });

  afterEach(() => {
    rmSync(vinyanHome, { recursive: true, force: true });
  });

  test('all paths scoped under $VINYAN_HOME/profiles/<name>/', () => {
    const result = resolveProfile({ vinyanHome, flag: 'work', env: EMPTY_ENV });
    const root = join(vinyanHome, 'profiles', 'work');
    expect(result.paths.configFile).toBe(join(root, 'vinyan.json'));
    expect(result.paths.dbDir).toBe(join(root, '.vinyan'));
    expect(result.paths.dbFile).toBe(join(root, '.vinyan', 'vinyan.db'));
    expect(result.paths.memoryDir).toBe(join(root, 'memory'));
    expect(result.paths.sessionsDir).toBe(join(root, 'sessions'));
    expect(result.paths.budgetDir).toBe(join(root, 'budget'));
    expect(result.paths.trustDir).toBe(join(root, 'trust'));
    expect(result.paths.secretsDir).toBe(join(root, 'secrets'));
    expect(result.paths.pidFile).toBe(join(root, 'serve.pid'));
  });

  test('globalConfigFile resolves to $VINYAN_HOME/config.global.json', () => {
    const result = resolveProfile({ vinyanHome, env: EMPTY_ENV });
    expect(result.globalConfigFile).toBe(join(vinyanHome, 'config.global.json'));
  });
});

describe('resolveProfile — createDirs: true', () => {
  let vinyanHome: string;

  beforeEach(() => {
    vinyanHome = mkdtempSync(join(tmpdir(), 'vinyan-profile-'));
  });

  afterEach(() => {
    rmSync(vinyanHome, { recursive: true, force: true });
  });

  test('creates full directory tree for profile', () => {
    const result = resolveProfile({ vinyanHome, flag: 'team', env: EMPTY_ENV, createDirs: true });
    for (const dir of [
      result.paths.dbDir,
      result.paths.memoryDir,
      result.paths.sessionsDir,
      result.paths.budgetDir,
      result.paths.trustDir,
      result.paths.secretsDir,
    ]) {
      expect(existsSync(dir)).toBe(true);
      expect(statSync(dir).isDirectory()).toBe(true);
    }
  });

  test('created directories have owner-only permissions (mode 0700)', () => {
    const result = resolveProfile({ vinyanHome, flag: 'team', env: EMPTY_ENV, createDirs: true });
    // POSIX permission check — `statSync.mode & 0o777` isolates the perm bits.
    const secretsMode = statSync(result.paths.secretsDir).mode & 0o777;
    expect(secretsMode).toBe(0o700);
    const rootMode = statSync(result.root).mode & 0o777;
    expect(rootMode).toBe(0o700);
  });

  test('second createDirs call is idempotent (no throw on existing dirs)', () => {
    resolveProfile({ vinyanHome, env: EMPTY_ENV, createDirs: true });
    expect(() => resolveProfile({ vinyanHome, env: EMPTY_ENV, createDirs: true })).not.toThrow();
  });
});

describe('resolveProfile — legacy flat-layout backwards compat', () => {
  let vinyanHome: string;

  beforeEach(() => {
    vinyanHome = mkdtempSync(join(tmpdir(), 'vinyan-profile-'));
    // Simulate a pre-profiles install: files at the flat root, no `profiles/`.
    mkdirSync(join(vinyanHome, '.vinyan'), { recursive: true, mode: 0o700 });
    mkdirSync(join(vinyanHome, 'memory'), { recursive: true, mode: 0o700 });
    writeFileSync(join(vinyanHome, 'vinyan.json'), JSON.stringify({ version: 1 }));
  });

  afterEach(() => {
    rmSync(vinyanHome, { recursive: true, force: true });
  });

  test('without createDirs → returns legacy paths + warning, does not throw', () => {
    const result = resolveProfile({ vinyanHome, env: EMPTY_ENV });
    expect(result.legacyLayout).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toMatch(/Legacy flat/);
    expect(result.paths.configFile).toBe(join(vinyanHome, 'vinyan.json'));
    expect(result.paths.dbDir).toBe(join(vinyanHome, '.vinyan'));
  });

  test('with createDirs → migrates flat state into profiles/default/', () => {
    const result = resolveProfile({ vinyanHome, env: EMPTY_ENV, createDirs: true });
    expect(result.legacyLayout).toBe(false);
    expect(result.paths.configFile).toBe(join(vinyanHome, 'profiles', 'default', 'vinyan.json'));
    expect(existsSync(result.paths.configFile)).toBe(true);
    expect(existsSync(result.paths.memoryDir)).toBe(true);
    // Warnings should note the migration count.
    expect(result.warnings.some((w) => /Migrated \d+ legacy entries/.test(w))).toBe(true);
  });
});

describe('loadLayeredConfig — merge order', () => {
  let vinyanHome: string;
  let workspace: string;

  beforeEach(() => {
    vinyanHome = mkdtempSync(join(tmpdir(), 'vinyan-profile-'));
    workspace = mkdtempSync(join(tmpdir(), 'vinyan-workspace-'));
  });

  afterEach(() => {
    rmSync(vinyanHome, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  test('no layers → pure schema defaults', () => {
    const profile = resolveProfile({ vinyanHome, env: EMPTY_ENV, createDirs: true });
    const config = loadLayeredConfig({ profile });
    expect(config.version).toBe(1);
    // Oracle defaults are populated by the schema.
    expect(config.oracles.ast?.enabled).toBe(true);
  });

  test('global < profile < project precedence (scalar override)', () => {
    const profile = resolveProfile({ vinyanHome, env: EMPTY_ENV, createDirs: true });

    writeFileSync(profile.globalConfigFile, JSON.stringify({ version: 2 }));
    writeFileSync(profile.paths.configFile, JSON.stringify({ version: 3 }));
    writeFileSync(join(workspace, 'vinyan.json'), JSON.stringify({ version: 4 }));

    const config = loadLayeredConfig({ profile, workspacePath: workspace });
    expect(config.version).toBe(4);
  });

  test('arrays replace (not concat) from overlay layer', () => {
    const profile = resolveProfile({ vinyanHome, env: EMPTY_ENV, createDirs: true });

    writeFileSync(
      profile.globalConfigFile,
      JSON.stringify({
        agents: [{ id: 'global-agent', name: 'G', description: 'from global' }],
      }),
    );
    writeFileSync(
      profile.paths.configFile,
      JSON.stringify({
        agents: [{ id: 'profile-agent', name: 'P', description: 'from profile' }],
      }),
    );

    const config = loadLayeredConfig({ profile });
    // Profile layer should fully replace the global-layer agents array.
    expect(config.agents).toHaveLength(1);
    expect(config.agents?.[0]?.id).toBe('profile-agent');
  });

  test('nested objects merge deeply, leaf scalars override', () => {
    const profile = resolveProfile({ vinyanHome, env: EMPTY_ENV, createDirs: true });

    writeFileSync(
      profile.globalConfigFile,
      JSON.stringify({
        oracles: {
          ast: { enabled: true, languages: ['typescript'] },
          type: { enabled: true, command: 'tsc --noEmit' },
        },
      }),
    );
    writeFileSync(
      profile.paths.configFile,
      JSON.stringify({
        oracles: {
          // Override just ast.enabled; other oracles from global should persist via merge.
          ast: { enabled: false, languages: ['typescript'] },
        },
      }),
    );

    const config = loadLayeredConfig({ profile });
    expect(config.oracles.ast?.enabled).toBe(false);
    // Type oracle survived from the global layer because merge is deep.
    expect(config.oracles.type?.enabled).toBe(true);
    expect(config.oracles.type?.command).toBe('tsc --noEmit');
  });

  test('rejects invalid layered config with Zod issue list', () => {
    const profile = resolveProfile({ vinyanHome, env: EMPTY_ENV, createDirs: true });
    writeFileSync(profile.paths.configFile, JSON.stringify({ oracles: { ast: { enabled: 'not-a-boolean' } } }));
    expect(() => loadLayeredConfig({ profile })).toThrow(/Invalid layered config/);
  });
});

describe('listProfiles', () => {
  let vinyanHome: string;

  beforeEach(() => {
    vinyanHome = mkdtempSync(join(tmpdir(), 'vinyan-profile-'));
  });

  afterEach(() => {
    rmSync(vinyanHome, { recursive: true, force: true });
  });

  test('returns empty list when profiles/ missing', () => {
    expect(listProfiles(vinyanHome)).toEqual([]);
  });

  test('lists only valid profile directories', () => {
    mkdirSync(join(vinyanHome, 'profiles', 'default'), { recursive: true });
    mkdirSync(join(vinyanHome, 'profiles', 'work'), { recursive: true });
    // Invalid name — starts with uppercase. Should be filtered out.
    mkdirSync(join(vinyanHome, 'profiles', 'BadName'), { recursive: true });
    // Non-dir entry — should be ignored.
    writeFileSync(join(vinyanHome, 'profiles', 'notes.txt'), 'hello');

    const names = listProfiles(vinyanHome).sort();
    expect(names).toEqual(['default', 'work']);
  });
});
