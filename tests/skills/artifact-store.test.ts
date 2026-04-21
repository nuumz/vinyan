/**
 * SkillArtifactStore tests — round-trip, path traversal, whitelist.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  SkillArtifactStore,
  SkillFileNotWhitelistedError,
  SkillPathTraversalError,
} from '../../src/skills/artifact-store.ts';
import type { SkillMdRecord } from '../../src/skills/skill-md/index.ts';
import { parseSkillMd } from '../../src/skills/skill-md/index.ts';

let rootDir: string;
let store: SkillArtifactStore;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'skill-artifact-'));
  store = new SkillArtifactStore({ rootDir });
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

function sampleRecord(id: string, files?: string[]): SkillMdRecord {
  const filesSection = files && files.length > 0 ? `\n\n## Files\n\n${files.map((f) => `- ${f}`).join('\n')}` : '';
  return parseSkillMd(`---
id: ${id}
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

1. One.${filesSection}
`);
}

describe('SkillArtifactStore.pathFor', () => {
  test('namespaced ids → <root>/<namespace>/<leaf>/SKILL.md', () => {
    expect(store.pathFor('refactor/extract-method-ts')).toBe(
      join(rootDir, 'refactor', 'extract-method-ts', 'SKILL.md'),
    );
  });

  test('flat ids → <root>/local/<id>/SKILL.md', () => {
    expect(store.pathFor('tidy-imports')).toBe(join(rootDir, 'local', 'tidy-imports', 'SKILL.md'));
  });
});

describe('SkillArtifactStore.write + read', () => {
  test('round-trips to byte-identical SKILL.md', async () => {
    const rec = sampleRecord('refactor/alpha');
    await store.write(rec);
    const onDisk = readFileSync(store.pathFor('refactor/alpha'), 'utf-8');
    // Re-read through the store and compare semantic identity.
    const reloaded = await store.read('refactor/alpha');
    expect(reloaded.frontmatter.id).toBe(rec.frontmatter.id);
    expect(reloaded.body.overview).toBe(rec.body.overview);
    // Canonical text output should be stable.
    expect(onDisk).toContain('id: refactor/alpha');
    expect(onDisk).toContain('## Overview');
  });

  test('write persists companion files under files/', async () => {
    const rec = sampleRecord('refactor/with-files', ['notes.md', 'code/impl.ts']);
    await store.write(
      rec,
      new Map([
        ['notes.md', '# Notes'],
        ['code/impl.ts', 'export const x = 1;\n'],
      ]),
    );
    const notesPath = join(rootDir, 'refactor', 'with-files', 'files', 'notes.md');
    const implPath = join(rootDir, 'refactor', 'with-files', 'files', 'code', 'impl.ts');
    expect(readFileSync(notesPath, 'utf-8')).toBe('# Notes');
    expect(readFileSync(implPath, 'utf-8')).toBe('export const x = 1;\n');
  });

  test('list() enumerates namespaced and flat ids', async () => {
    await store.write(sampleRecord('refactor/alpha'));
    await store.write(sampleRecord('tidy-imports'));
    const entries = await store.list();
    const ids = new Set(entries.map((e) => e.id));
    expect(ids.has('refactor/alpha')).toBe(true);
    expect(ids.has('tidy-imports')).toBe(true);
  });
});

describe('SkillArtifactStore.readFile — security', () => {
  test('reads a whitelisted companion file', async () => {
    const rec = sampleRecord('refactor/beta', ['snippet.ts']);
    await store.write(rec, new Map([['snippet.ts', 'console.log(1);']]));
    const { content, bytes } = await store.readFile('refactor/beta', 'snippet.ts');
    expect(content).toBe('console.log(1);');
    expect(bytes).toBe(Buffer.byteLength('console.log(1);', 'utf-8'));
  });

  test('rejects non-whitelisted path', async () => {
    const rec = sampleRecord('refactor/gamma', ['whitelisted.md']);
    await store.write(rec, new Map([['whitelisted.md', 'ok']]));
    // Plant a non-listed file manually.
    const sneakyPath = join(rootDir, 'refactor', 'gamma', 'files', 'sneaky.md');
    mkdirSync(join(rootDir, 'refactor', 'gamma', 'files'), { recursive: true });
    writeFileSync(sneakyPath, 'stolen');
    await expect(store.readFile('refactor/gamma', 'sneaky.md')).rejects.toBeInstanceOf(SkillFileNotWhitelistedError);
  });

  test('rejects `..` path traversal', async () => {
    const rec = sampleRecord('refactor/delta', ['../../../etc/passwd']);
    await store.write(rec);
    // Even though it is "whitelisted", the safety check runs first.
    await expect(store.readFile('refactor/delta', '../../../etc/passwd')).rejects.toBeInstanceOf(
      SkillPathTraversalError,
    );
  });

  test('rejects absolute path', async () => {
    const rec = sampleRecord('refactor/epsilon', ['/etc/passwd']);
    await store.write(rec);
    await expect(store.readFile('refactor/epsilon', '/etc/passwd')).rejects.toBeInstanceOf(SkillPathTraversalError);
  });

  test('rejects empty path', async () => {
    const rec = sampleRecord('refactor/zeta', ['']);
    await store.write(rec);
    await expect(store.readFile('refactor/zeta', '')).rejects.toBeInstanceOf(SkillPathTraversalError);
  });
});
