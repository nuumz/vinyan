import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { init } from '../../src/cli/init.ts';

describe('vinyan init', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'vinyan-cli-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  test('init in TypeScript project → vinyan.json with type oracle enabled', () => {
    writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
    writeFileSync(join(tempDir, 'package.json'), '{}');

    const result = init(tempDir, { userSkillsDir: false });
    expect(result.created).toBe(true);
    expect(result.starterPackCopied).toBeUndefined(); // userSkillsDir: false → no seeding
    expect(existsSync(join(tempDir, 'vinyan.json'))).toBe(true);

    const config = JSON.parse(readFileSync(join(tempDir, 'vinyan.json'), 'utf-8'));
    expect(config.version).toBe(1);
    expect(config.oracles.type.enabled).toBe(true);
    expect(config.oracles.ast.languages).toContain('typescript');
  });

  test('init in Python project → no type oracle', () => {
    writeFileSync(join(tempDir, 'pyproject.toml'), '');

    const result = init(tempDir, { userSkillsDir: false });
    expect(result.created).toBe(true);

    const config = JSON.parse(readFileSync(join(tempDir, 'vinyan.json'), 'utf-8'));
    expect(config.oracles.type).toBeUndefined();
    expect(config.oracles.ast.languages).toContain('python');
  });

  test('init in empty project → minimal defaults with typescript', () => {
    const result = init(tempDir, { userSkillsDir: false });
    expect(result.created).toBe(true);

    const config = JSON.parse(readFileSync(join(tempDir, 'vinyan.json'), 'utf-8'));
    expect(config.oracles.ast.languages).toContain('typescript');
    expect(config.oracles.dep.enabled).toBe(true);
  });

  test('init creates .vinyan/skills/ directory so users can drop in SKILL.md files', () => {
    init(tempDir, { userSkillsDir: false });
    expect(existsSync(join(tempDir, '.vinyan', 'skills'))).toBe(true);
  });

  test('init seeds starter pack into the supplied user skills dir', () => {
    const userDir = mkdtempSync(join(tmpdir(), 'vinyan-init-userdir-'));
    rmSync(userDir, { recursive: true, force: true });
    try {
      const result = init(tempDir, { userSkillsDir: userDir });
      expect(result.created).toBe(true);
      expect(result.starterPackCopied?.length ?? 0).toBeGreaterThan(0);
      expect(existsSync(join(userDir, 'code-review', 'SKILL.md'))).toBe(true);
    } finally {
      rmSync(userDir, { recursive: true, force: true });
    }
  });

  test("don't overwrite existing config", () => {
    writeFileSync(join(tempDir, 'vinyan.json'), '{"version":99}');

    const result = init(tempDir, { userSkillsDir: false });
    expect(result.created).toBe(false);
    expect(result.reason).toContain('already exists');

    // Original content preserved
    const config = JSON.parse(readFileSync(join(tempDir, 'vinyan.json'), 'utf-8'));
    expect(config.version).toBe(99);
  });

  test('--force overwrites existing config', () => {
    writeFileSync(join(tempDir, 'vinyan.json'), '{"version":99}');

    const result = init(tempDir, { force: true, userSkillsDir: false });
    expect(result.created).toBe(true);

    const config = JSON.parse(readFileSync(join(tempDir, 'vinyan.json'), 'utf-8'));
    expect(config.version).toBe(1);
  });

  test('mixed project → both languages detected', () => {
    writeFileSync(join(tempDir, 'tsconfig.json'), '{}');
    writeFileSync(join(tempDir, 'pyproject.toml'), '');

    const result = init(tempDir, { userSkillsDir: false });
    expect(result.created).toBe(true);

    const config = JSON.parse(readFileSync(join(tempDir, 'vinyan.json'), 'utf-8'));
    expect(config.oracles.ast.languages).toContain('typescript');
    expect(config.oracles.ast.languages).toContain('python');
    expect(config.oracles.type.enabled).toBe(true); // has tsconfig
  });
});
