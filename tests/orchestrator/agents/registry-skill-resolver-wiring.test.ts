/**
 * Smoking-gun fix: `loadAgentRegistry` honours `options.skillResolver`.
 *
 * Background — the registry's `getDerivedCapabilities` was returning
 * `loadedSkills: []` for every persona on every workspace. Root cause was at
 * `factory.ts:1554` which never passed a resolver into the 4th arg. Plan-A
 * Phase-1 (Hybrid Skill Redesign) wires `buildSyncSkillResolver` into both
 * call sites in factory.ts.
 *
 * These tests prove the registry contract end-to-end by:
 *   1. Writing a SKILL.md to disk under `.vinyan/skills/local/<id>/`
 *   2. Building a sync resolver from that workspace
 *   3. Binding the skill to a persona via `saveBoundSkills`
 *   4. Asserting the registry returns the SKILL.md in `loadedSkills`
 *
 * The "without resolver" test is the regression check — it codifies the
 * old behaviour as the explicit fallback so future refactors don't silently
 * re-break the contract.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { saveBoundSkills } from '../../../src/orchestrator/agents/persona-skill-loader.ts';
import { loadAgentRegistry } from '../../../src/orchestrator/agents/registry.ts';
import { clearSoulCache } from '../../../src/orchestrator/agents/soul-loader.ts';
import { buildSyncSkillResolver } from '../../../src/skills/sync-skill-resolver.ts';

let workspace: string;

const SAMPLE_SKILL = `---
id: review-checklist
name: Review Checklist
version: 1.0.0
description: Step-by-step code review checklist
confidence_tier: heuristic
---

## Overview

A structured review approach.

## When to use

When reviewing pull requests.

## Procedure

1. Read the diff end-to-end before commenting.
2. Check error paths.
3. Verify test coverage.
`;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'vinyan-resolver-wire-'));
  clearSoulCache();
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function plantSkill(): void {
  const skillDir = join(workspace, '.vinyan', 'skills', 'local', 'review-checklist');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), SAMPLE_SKILL);
}

describe('registry honours skillResolver (smoking-gun fix)', () => {
  test('with resolver + bound skill → loadedSkills populated', () => {
    plantSkill();
    saveBoundSkills(workspace, 'reviewer', [{ id: 'review-checklist' }]);

    const { resolver, loadedCount } = buildSyncSkillResolver(
      join(workspace, '.vinyan', 'skills'),
    );
    expect(loadedCount).toBe(1);

    const reg = loadAgentRegistry(workspace, undefined, undefined, {
      skillResolver: resolver,
      enableSkillComposition: true,
    });
    const derived = reg.getDerivedCapabilities('reviewer');

    expect(derived).not.toBeNull();
    expect(derived?.loadedSkills.length).toBe(1);
    expect(derived?.loadedSkills[0]?.frontmatter.id).toBe('review-checklist');
    expect(derived?.resolvedRefs.length).toBe(1);
    expect(derived?.skipped.length).toBe(0);
  });

  test('without resolver → loadedSkills stays empty (regression check)', () => {
    plantSkill();
    saveBoundSkills(workspace, 'reviewer', [{ id: 'review-checklist' }]);

    // Mimic the old (broken) factory call — no options arg.
    const reg = loadAgentRegistry(workspace, undefined);
    const derived = reg.getDerivedCapabilities('reviewer');

    expect(derived).not.toBeNull();
    expect(derived?.loadedSkills).toEqual([]);
    expect(derived?.resolvedRefs).toEqual([]);
  });

  test('with resolver but empty skill dir → empty loadedSkills, no skip records', () => {
    // No skill planted, no bind.
    const { resolver } = buildSyncSkillResolver(join(workspace, '.vinyan', 'skills'));
    const reg = loadAgentRegistry(workspace, undefined, undefined, {
      skillResolver: resolver,
      enableSkillComposition: true,
    });
    const derived = reg.getDerivedCapabilities('reviewer');

    expect(derived?.loadedSkills).toEqual([]);
    expect(derived?.skipped).toEqual([]);
  });

  test('bound id missing on disk → recorded in skipped, not loaded', () => {
    // Resolver sees nothing, but persona has a bind to a missing id.
    saveBoundSkills(workspace, 'reviewer', [{ id: 'ghost-skill' }]);
    const { resolver } = buildSyncSkillResolver(join(workspace, '.vinyan', 'skills'));
    const reg = loadAgentRegistry(workspace, undefined, undefined, {
      skillResolver: resolver,
      enableSkillComposition: true,
    });

    const derived = reg.getDerivedCapabilities('reviewer');
    expect(derived?.loadedSkills).toEqual([]);
    expect(derived?.skipped.length).toBe(1);
    expect(derived?.skipped[0]?.ref.id).toBe('ghost-skill');
    expect(derived?.skipped[0]?.reason).toBe('not-found');
  });

  test('extraRefs (acquired scope) layered on top of bound', () => {
    plantSkill();
    saveBoundSkills(workspace, 'reviewer', []);

    const { resolver } = buildSyncSkillResolver(join(workspace, '.vinyan', 'skills'));
    const reg = loadAgentRegistry(workspace, undefined, undefined, {
      skillResolver: resolver,
      enableSkillComposition: true,
    });

    const derived = reg.getDerivedCapabilities('reviewer', {
      extraRefs: [{ id: 'review-checklist' }],
    });
    expect(derived?.loadedSkills.length).toBe(1);
    expect(derived?.loadedSkills[0]?.frontmatter.id).toBe('review-checklist');
  });
});
