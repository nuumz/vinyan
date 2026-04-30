/**
 * SyncSkillResolver tests — Phase 1 (Hybrid Skill Redesign).
 *
 * Verifies the smoking-gun fix: the registry's sync `getDerivedCapabilities`
 * path needs a sync `SkillResolver`, but `SkillArtifactStore` is async. The
 * resolver pre-loads the entire skill tree at boot so registry construction
 * stays synchronous.
 *
 * Behaviour contract:
 *   - Missing root dir → empty resolver, no throw, loadedCount=0
 *   - Loads SKILL.md from `<rootDir>/local/<id>/SKILL.md` (flat ids)
 *   - Loads SKILL.md from `<rootDir>/<ns>/<leaf>/SKILL.md` (namespaced ids)
 *   - Skill that fails to parse is logged + recorded in `failedIds`, others
 *     load (A9 — degrade, don't cascade)
 *   - `resolve()` returns null for unknown ids
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSyncSkillResolver } from '../../src/skills/sync-skill-resolver.ts';

let rootDir: string;

const VALID_SKILL_MD = `---
id: __ID__
name: Sample
version: 1.0.0
description: A sample skill
confidence_tier: heuristic
---

## Overview

Overview.

## When to use

When testing.

## Procedure

1. One.
`;

function writeSkill(dir: string, id: string, body: string = VALID_SKILL_MD): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), body.replace('__ID__', id));
}

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'sync-resolver-'));
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

describe('buildSyncSkillResolver — empty cases', () => {
  test('missing root dir → empty resolver, loadedCount=0', () => {
    const result = buildSyncSkillResolver(join(rootDir, 'does-not-exist'));
    expect(result.loadedCount).toBe(0);
    expect(result.failedIds).toEqual([]);
    expect(result.resolver.resolve({ id: 'whatever' })).toBeNull();
  });

  test('empty root dir → empty resolver, no throw', () => {
    const result = buildSyncSkillResolver(rootDir);
    expect(result.loadedCount).toBe(0);
    expect(result.resolver.resolve({ id: 'anything' })).toBeNull();
  });
});

describe('buildSyncSkillResolver — flat ids', () => {
  test('reads <rootDir>/local/<id>/SKILL.md', () => {
    writeSkill(join(rootDir, 'local', 'tidy-imports'), 'tidy-imports');

    const result = buildSyncSkillResolver(rootDir);
    expect(result.loadedCount).toBe(1);

    const record = result.resolver.resolve({ id: 'tidy-imports' });
    expect(record).not.toBeNull();
    expect(record?.frontmatter.id).toBe('tidy-imports');
    expect(record?.frontmatter.name).toBe('Sample');
  });

  test('multiple flat skills loaded', () => {
    writeSkill(join(rootDir, 'local', 'a'), 'a');
    writeSkill(join(rootDir, 'local', 'b'), 'b');
    writeSkill(join(rootDir, 'local', 'c'), 'c');

    const result = buildSyncSkillResolver(rootDir);
    expect(result.loadedCount).toBe(3);
    expect(result.resolver.resolve({ id: 'a' })).not.toBeNull();
    expect(result.resolver.resolve({ id: 'b' })).not.toBeNull();
    expect(result.resolver.resolve({ id: 'c' })).not.toBeNull();
  });
});

describe('buildSyncSkillResolver — namespaced ids', () => {
  test('reads <rootDir>/<ns>/<leaf>/SKILL.md as ns/leaf', () => {
    writeSkill(
      join(rootDir, 'refactor', 'extract-method-ts'),
      'refactor/extract-method-ts',
    );

    const result = buildSyncSkillResolver(rootDir);
    expect(result.loadedCount).toBe(1);
    expect(result.resolver.resolve({ id: 'refactor/extract-method-ts' })).not.toBeNull();
    expect(result.resolver.resolve({ id: 'extract-method-ts' })).toBeNull();
  });

  test('flat + namespaced coexist', () => {
    writeSkill(join(rootDir, 'local', 'flat'), 'flat');
    writeSkill(join(rootDir, 'team', 'scoped'), 'team/scoped');

    const result = buildSyncSkillResolver(rootDir);
    expect(result.loadedCount).toBe(2);
    expect(result.resolver.resolve({ id: 'flat' })).not.toBeNull();
    expect(result.resolver.resolve({ id: 'team/scoped' })).not.toBeNull();
  });
});

describe('buildSyncSkillResolver — A9 degradation', () => {
  test('malformed SKILL.md → recorded in failedIds, others load', () => {
    writeSkill(join(rootDir, 'local', 'good-1'), 'good-1');
    writeSkill(
      join(rootDir, 'local', 'broken'),
      'broken',
      '---\nid: broken\n# missing required fields\n---\n',
    );
    writeSkill(join(rootDir, 'local', 'good-2'), 'good-2');

    const result = buildSyncSkillResolver(rootDir);
    expect(result.loadedCount).toBe(2);
    expect(result.failedIds).toEqual(['broken']);
    expect(result.resolver.resolve({ id: 'good-1' })).not.toBeNull();
    expect(result.resolver.resolve({ id: 'broken' })).toBeNull();
    expect(result.resolver.resolve({ id: 'good-2' })).not.toBeNull();
  });

  test('directory without SKILL.md is silently skipped', () => {
    mkdirSync(join(rootDir, 'local', 'no-skill-md'), { recursive: true });
    writeSkill(join(rootDir, 'local', 'has-skill'), 'has-skill');

    const result = buildSyncSkillResolver(rootDir);
    expect(result.loadedCount).toBe(1);
    expect(result.failedIds).toEqual([]);
  });

  test('non-directory entry at namespace level skipped', () => {
    writeFileSync(join(rootDir, 'stray.txt'), 'not a skill');
    writeSkill(join(rootDir, 'local', 'real'), 'real');

    const result = buildSyncSkillResolver(rootDir);
    expect(result.loadedCount).toBe(1);
  });
});

describe('buildSyncSkillResolver — resolver semantics', () => {
  test('resolve() returns null for unknown ids', () => {
    writeSkill(join(rootDir, 'local', 'known'), 'known');

    const result = buildSyncSkillResolver(rootDir);
    expect(result.resolver.resolve({ id: 'unknown' })).toBeNull();
  });

  test('resolve() returns the same record on repeated calls', () => {
    writeSkill(join(rootDir, 'local', 'stable'), 'stable');

    const result = buildSyncSkillResolver(rootDir);
    const a = result.resolver.resolve({ id: 'stable' });
    const b = result.resolver.resolve({ id: 'stable' });
    expect(a).toBe(b);
  });
});
