/**
 * Simple skill loader tests — Claude-Code-style SKILL.md format.
 *
 * Covers:
 *   - Frontmatter parsing (well-formed, malformed, with quotes/comments)
 *   - Both scopes (user-global + project)
 *   - Project precedence over user on name conflict
 *   - Description cap @ DESCRIPTION_CHAR_CAP
 *   - A9: malformed file → recorded in failedNames, others load
 *   - Skip the `local/` namespace (owned by epistemic stack)
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DESCRIPTION_CHAR_CAP,
  loadSimpleSkills,
  parseFrontmatter,
} from '../../../src/skills/simple/loader.ts';

let userDir: string;
let projectDir: string;
let workspace: string;

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'simple-skill-ws-'));
  userDir = mkdtempSync(join(tmpdir(), 'simple-skill-user-'));
  projectDir = mkdtempSync(join(tmpdir(), 'simple-skill-proj-'));
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
  rmSync(userDir, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

function plant(rootDir: string, name: string, content: string): void {
  const dir = join(rootDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), content);
}

const SAMPLE = `---
name: code-review
description: Review code for bugs and style. Use when reviewing PRs.
---

When reviewing code:
1. Check null derefs
2. Verify error handling
`;

describe('parseFrontmatter', () => {
  test('extracts name + description', () => {
    const parsed = parseFrontmatter(SAMPLE);
    expect(parsed).not.toBeNull();
    expect(parsed!.frontmatter.name).toBe('code-review');
    expect(parsed!.frontmatter.description).toBe('Review code for bugs and style. Use when reviewing PRs.');
    expect(parsed!.body).toContain('When reviewing code');
  });

  test('strips surrounding quotes from values', () => {
    const text = '---\nname: "quoted-name"\ndescription: \'single quoted\'\n---\nbody\n';
    const parsed = parseFrontmatter(text);
    expect(parsed!.frontmatter.name).toBe('quoted-name');
    expect(parsed!.frontmatter.description).toBe('single quoted');
  });

  test('ignores lines without colon and trailing comments', () => {
    const text = '---\nname: ok\ngarbage line\ndescription: hello # inline comment\n---\nbody\n';
    const parsed = parseFrontmatter(text);
    expect(parsed!.frontmatter.name).toBe('ok');
    expect(parsed!.frontmatter.description).toBe('hello');
  });

  test('returns null when no frontmatter present', () => {
    const text = '# Just a markdown file\n\nbody\n';
    expect(parseFrontmatter(text)).toBeNull();
  });

  test('handles CRLF line endings', () => {
    const text = '---\r\nname: crlf\r\n---\r\nbody\r\n';
    const parsed = parseFrontmatter(text);
    expect(parsed!.frontmatter.name).toBe('crlf');
  });
});

describe('loadSimpleSkills — basic', () => {
  test('loads skill from project scope', () => {
    plant(projectDir, 'code-review', SAMPLE);

    const result = loadSimpleSkills({ workspace, userSkillsDir: userDir, projectSkillsDir: projectDir });
    expect(result.skills.length).toBe(1);
    expect(result.skills[0]?.name).toBe('code-review');
    expect(result.skills[0]?.scope).toBe('project');
    expect(result.skills[0]?.description).toBe(
      'Review code for bugs and style. Use when reviewing PRs.',
    );
  });

  test('loads skill from user-global scope', () => {
    plant(userDir, 'debug-trace', SAMPLE.replace('code-review', 'debug-trace'));

    const result = loadSimpleSkills({ workspace, userSkillsDir: userDir, projectSkillsDir: projectDir });
    expect(result.skills.length).toBe(1);
    expect(result.skills[0]?.scope).toBe('user');
  });

  test('returns empty when both dirs missing', () => {
    const result = loadSimpleSkills({
      workspace,
      userSkillsDir: join(userDir, 'nope'),
      projectSkillsDir: join(projectDir, 'nope'),
    });
    expect(result.skills).toEqual([]);
    expect(result.failedNames).toEqual([]);
  });
});

describe('loadSimpleSkills — scope precedence', () => {
  test('project skill overrides user-global on name collision', () => {
    plant(userDir, 'shared', '---\nname: shared\ndescription: user version\n---\nuser body\n');
    plant(projectDir, 'shared', '---\nname: shared\ndescription: project version\n---\nproject body\n');

    const result = loadSimpleSkills({ workspace, userSkillsDir: userDir, projectSkillsDir: projectDir });
    expect(result.skills.length).toBe(1);
    expect(result.skills[0]?.scope).toBe('project');
    expect(result.skills[0]?.description).toBe('project version');
  });

  test('non-conflicting skills from both scopes coexist', () => {
    plant(userDir, 'a', '---\nname: a\ndescription: aa\n---\nbody\n');
    plant(projectDir, 'b', '---\nname: b\ndescription: bb\n---\nbody\n');

    const result = loadSimpleSkills({ workspace, userSkillsDir: userDir, projectSkillsDir: projectDir });
    expect(result.skills.length).toBe(2);
    expect(result.skills.map((s) => s.name)).toEqual(['a', 'b']);
  });
});

describe('loadSimpleSkills — A9 degradation', () => {
  test('malformed frontmatter → recorded in failedNames, others load', () => {
    plant(projectDir, 'good', SAMPLE);
    plant(projectDir, 'broken', 'no frontmatter here\n');

    const result = loadSimpleSkills({ workspace, userSkillsDir: userDir, projectSkillsDir: projectDir });
    expect(result.skills.length).toBe(1);
    expect(result.skills[0]?.name).toBe('code-review');
    expect(result.failedNames).toContain('broken');
  });

  test('skill dir without SKILL.md is silently skipped', () => {
    mkdirSync(join(projectDir, 'no-skill-md'), { recursive: true });
    plant(projectDir, 'real', SAMPLE);

    const result = loadSimpleSkills({ workspace, userSkillsDir: userDir, projectSkillsDir: projectDir });
    expect(result.skills.length).toBe(1);
  });

  test('frontmatter with no name → falls back to dir name', () => {
    plant(projectDir, 'directory-fallback', '---\ndescription: no name field\n---\nbody\n');

    const result = loadSimpleSkills({ workspace, userSkillsDir: userDir, projectSkillsDir: projectDir });
    expect(result.skills.length).toBe(1);
    expect(result.skills[0]?.name).toBe('directory-fallback');
  });
});

describe('loadSimpleSkills — description cap', () => {
  test('description ≤ cap is preserved verbatim', () => {
    plant(projectDir, 'short', '---\nname: short\ndescription: under cap\n---\nbody\n');
    const result = loadSimpleSkills({ workspace, userSkillsDir: userDir, projectSkillsDir: projectDir });
    expect(result.skills[0]?.description).toBe('under cap');
  });

  test('description > cap is truncated with ellipsis', () => {
    const long = 'x'.repeat(DESCRIPTION_CHAR_CAP + 100);
    plant(projectDir, 'long', `---\nname: long\ndescription: ${long}\n---\nbody\n`);
    const result = loadSimpleSkills({ workspace, userSkillsDir: userDir, projectSkillsDir: projectDir });
    expect(result.skills[0]?.description.length).toBe(DESCRIPTION_CHAR_CAP);
    expect(result.skills[0]?.description.endsWith('…')).toBe(true);
  });
});

describe('loadSimpleSkills — namespace boundaries', () => {
  test('skips local/ namespace (owned by epistemic stack)', () => {
    // Heavy-schema skills live at <root>/local/<id>/SKILL.md — the simple
    // loader must NOT pick those up so the two layers don't double-claim.
    mkdirSync(join(projectDir, 'local', 'epistemic-skill'), { recursive: true });
    writeFileSync(
      join(projectDir, 'local', 'epistemic-skill', 'SKILL.md'),
      '---\nid: epistemic-skill\nname: heavy\nversion: 1.0.0\ndescription: heavy\nconfidence_tier: heuristic\n---\n## Overview\n\n.\n## When to use\n\n.\n## Procedure\n\n.\n',
    );

    plant(projectDir, 'simple-skill', SAMPLE);

    const result = loadSimpleSkills({ workspace, userSkillsDir: userDir, projectSkillsDir: projectDir });
    const names = result.skills.map((s) => s.name);
    expect(names).not.toContain('heavy');
    expect(names).not.toContain('epistemic-skill');
    expect(names).toContain('code-review');
  });
});
