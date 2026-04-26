/**
 * SKILL.md writer tests — verify canonical output is parseable, key-sorted,
 * section-ordered, and trailing-whitespace-free.
 */
import { describe, expect, test } from 'bun:test';

import { parseSkillMd } from '../../../src/skills/skill-md/parser.ts';
import type { SkillMdRecord } from '../../../src/skills/skill-md/schema.ts';
import { writeSkillMd } from '../../../src/skills/skill-md/writer.ts';

function buildRecord(): SkillMdRecord {
  // Build via the parser so we don't duplicate schema defaults here.
  return parseSkillMd(`---
id: refactor/extract-method-ts
name: Extract Method
version: 1.0.0
description: Extract a selection
confidence_tier: heuristic
requires_toolsets:
  - ast
  - type
---

## Overview

Overview text.

## When to use

When refactoring long functions.

## Procedure

1. Step one.
2. Step two.

## Files

- src/a.ts
- src/b.ts
`);
}

describe('writeSkillMd', () => {
  test('emits parseable canonical output', () => {
    const rec = buildRecord();
    const text = writeSkillMd(rec);
    expect(() => parseSkillMd(text)).not.toThrow();
  });

  test('frontmatter keys are sorted alphabetically', () => {
    const rec = buildRecord();
    const text = writeSkillMd(rec);
    const fmMatch = /^---\n([\s\S]*?)\n---/.exec(text);
    expect(fmMatch).not.toBeNull();
    const fmBody = fmMatch![1]!;
    // Collect top-level keys (lines not starting with space and containing ':')
    const topKeys: string[] = [];
    for (const line of fmBody.split('\n')) {
      const m = /^([a-z_][a-z0-9_]*):/i.exec(line);
      if (m) topKeys.push(m[1]!);
    }
    const sorted = [...topKeys].sort();
    expect(topKeys).toEqual(sorted);
  });

  test('body sections appear in canonical order', () => {
    const rec = buildRecord();
    const text = writeSkillMd(rec);
    const overviewIdx = text.indexOf('## Overview');
    const whenIdx = text.indexOf('## When to use');
    const procIdx = text.indexOf('## Procedure');
    const filesIdx = text.indexOf('## Files');
    expect(overviewIdx).toBeGreaterThanOrEqual(0);
    expect(whenIdx).toBeGreaterThan(overviewIdx);
    expect(procIdx).toBeGreaterThan(whenIdx);
    expect(filesIdx).toBeGreaterThan(procIdx);
  });

  test('unknown sections appear after known sections, alphabetized', () => {
    const rec = parseSkillMd(`---
id: hello
name: Hello
version: 0.1.0
description: x
confidence_tier: probabilistic
---

## Overview
x

## When to use
x

## Procedure
x

## Zeta extras
z

## Examples
y
`);
    const text = writeSkillMd(rec);
    const procIdx = text.indexOf('## Procedure');
    const examplesIdx = text.indexOf('## Examples');
    const zetaIdx = text.indexOf('## Zeta extras');
    expect(examplesIdx).toBeGreaterThan(procIdx);
    expect(zetaIdx).toBeGreaterThan(examplesIdx);
  });

  test('no line carries trailing whitespace', () => {
    const rec = buildRecord();
    const text = writeSkillMd(rec);
    for (const line of text.split('\n')) {
      expect(line).toBe(line.replace(/[ \t]+$/, ''));
    }
  });

  test('terminates with a single newline', () => {
    const rec = buildRecord();
    const text = writeSkillMd(rec);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.endsWith('\n\n')).toBe(false);
  });

  test('collapses 3+ consecutive blank lines within a section', () => {
    const rec = parseSkillMd(`---
id: hello
name: Hello
version: 0.1.0
description: x
confidence_tier: probabilistic
---

## Overview

Line 1.



Line 2.

## When to use
x

## Procedure
x
`);
    const text = writeSkillMd(rec);
    expect(text).not.toMatch(/\n\n\n/);
  });
});
