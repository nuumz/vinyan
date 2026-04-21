/**
 * SKILL.md parser tests — verify the text → record pipeline enforces the
 * structural and schema invariants from Decision 20.
 */
import { describe, expect, test } from 'bun:test';

import { parseSkillMd } from '../../../src/skills/skill-md/parser.ts';
import { SkillMdParseError } from '../../../src/skills/skill-md/schema.ts';

const VALID_FULL = `---
id: refactor/extract-method-ts
name: Extract Method (TypeScript)
version: 1.2.3
description: Extract a selection into a new function
author: Vinyan Core
license: Apache-2.0
requires_toolsets:
  - ast
  - type
fallback_for_toolsets: []
platforms:
  - darwin
  - linux

confidence_tier: heuristic
origin: local
declared_oracles:
  - ast
  - type
falsifiable_by:
  - tsc --noEmit
expected_prediction_error_reduction:
  baseline_composite_error: 0.35
  target_composite_error: 0.18
  trial_window: 25
status: probation
---

## Overview

This skill extracts a contiguous selection into a new function.

## When to use

When the user selects a block of statements in a long function and the AST
oracle confirms it is a single contiguous region.

## Preconditions

- target file parses cleanly
- type oracle reports no errors on the pre-state

## Procedure

1. Capture selection range.
2. Run ast.symbol-scope on the selection.
3. Emit a new function declaration above the current scope.

## Files

- src/refactor/extract-method.ts
- src/refactor/util.ts

## Falsification

\`\`\`vinyan-falsify
oracle: type
expect: passes post-edit
\`\`\`
`;

const VALID_MINIMAL = `---
id: hello
name: Hello
version: 0.1.0
description: Minimal viable skill
confidence_tier: probabilistic
---

## Overview

Minimal.

## When to use

Never — it is a test fixture.

## Procedure

Do nothing.
`;

describe('parseSkillMd — happy paths', () => {
  test('parses a full-featured SKILL.md', () => {
    const rec = parseSkillMd(VALID_FULL);

    expect(rec.frontmatter.id).toBe('refactor/extract-method-ts');
    expect(rec.frontmatter.version).toBe('1.2.3');
    expect(rec.frontmatter.confidence_tier).toBe('heuristic');
    expect(rec.frontmatter.requires_toolsets).toEqual(['ast', 'type']);
    expect(rec.frontmatter.platforms).toEqual(['darwin', 'linux']);
    expect(rec.frontmatter.expected_prediction_error_reduction).toEqual({
      baseline_composite_error: 0.35,
      target_composite_error: 0.18,
      trial_window: 25,
    });

    expect(rec.body.overview).toContain('extracts a contiguous selection');
    expect(rec.body.whenToUse).toContain('selects a block');
    expect(rec.body.preconditions).toContain('target file parses');
    expect(rec.body.procedure).toContain('Capture selection range');
    expect(rec.body.files).toEqual(['src/refactor/extract-method.ts', 'src/refactor/util.ts']);
    expect(rec.body.falsification?.blocks).toEqual([{ oracle: 'type', expect: 'passes post-edit' }]);
    expect(rec.contentHash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test('parses a minimal SKILL.md (only required fields + sections)', () => {
    const rec = parseSkillMd(VALID_MINIMAL);
    expect(rec.frontmatter.id).toBe('hello');
    // Defaults applied by Zod
    expect(rec.frontmatter.origin).toBe('local');
    expect(rec.frontmatter.status).toBe('probation');
    expect(rec.frontmatter.requires_toolsets).toEqual([]);
    expect(rec.frontmatter.fallback_for_toolsets).toEqual([]);
    expect(rec.frontmatter.declared_oracles).toEqual([]);
    expect(rec.frontmatter.falsifiable_by).toEqual([]);

    expect(rec.body.overview).toBe('Minimal.');
    expect(rec.body.preconditions).toBeUndefined();
    expect(rec.body.files).toBeUndefined();
    expect(rec.body.falsification).toBeUndefined();
    expect(rec.body.unknownSections).toBeUndefined();
  });

  test('preserves unknown H2 sections', () => {
    const text = VALID_MINIMAL.replace(
      '## Procedure\n\nDo nothing.\n',
      '## Procedure\n\nDo nothing.\n\n## Examples\n\nSee tests.\n',
    );
    const rec = parseSkillMd(text);
    expect(rec.body.unknownSections).toBeDefined();
    expect(rec.body.unknownSections?.Examples).toContain('See tests.');
  });
});

describe('parseSkillMd — structural errors', () => {
  test('missing opening --- throws with line 1', () => {
    expect(() => parseSkillMd('## Overview\n\ncontent\n')).toThrow(SkillMdParseError);
    try {
      parseSkillMd('## Overview\n\ncontent\n');
    } catch (err) {
      expect(err).toBeInstanceOf(SkillMdParseError);
      expect((err as SkillMdParseError).line).toBe(1);
    }
  });

  test('unterminated frontmatter throws', () => {
    const bad = `---
id: a
name: A
version: 1.0.0
description: x
confidence_tier: probabilistic
`;
    expect(() => parseSkillMd(bad)).toThrow(SkillMdParseError);
  });

  test('missing ## Overview throws SkillMdParseError naming the section', () => {
    const bad = VALID_MINIMAL.replace('## Overview\n\nMinimal.\n\n', '');
    try {
      parseSkillMd(bad);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SkillMdParseError);
      expect((err as SkillMdParseError).section).toBe('Overview');
      expect((err as SkillMdParseError).message).toContain('Overview');
      expect(typeof (err as SkillMdParseError).line).toBe('number');
    }
  });

  test('missing ## Procedure throws SkillMdParseError', () => {
    const bad = VALID_MINIMAL.replace('## Procedure\n\nDo nothing.\n', '');
    try {
      parseSkillMd(bad);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SkillMdParseError);
      expect((err as SkillMdParseError).section).toBe('Procedure');
    }
  });

  test('invalid YAML frontmatter produces a useful message', () => {
    const bad = `---
id: x
  this is: [not valid
---

## Overview
x

## When to use
x

## Procedure
x
`;
    try {
      parseSkillMd(bad);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(SkillMdParseError);
      expect((err as SkillMdParseError).message.toLowerCase()).toContain('yaml');
    }
  });
});

describe('parseSkillMd — schema errors', () => {
  test("confidence_tier 'deterministic' without content_hash is rejected", () => {
    const bad = VALID_MINIMAL.replace('confidence_tier: probabilistic', 'confidence_tier: deterministic');
    expect(() => parseSkillMd(bad)).toThrow(SkillMdParseError);
  });

  test("confidence_tier 'deterministic' WITH content_hash is accepted", () => {
    const good = VALID_MINIMAL.replace(
      'confidence_tier: probabilistic',
      `confidence_tier: deterministic\ncontent_hash: sha256:${'a'.repeat(64)}`,
    );
    const rec = parseSkillMd(good);
    expect(rec.frontmatter.confidence_tier).toBe('deterministic');
  });

  test('malformed semver is rejected', () => {
    const bad = VALID_MINIMAL.replace('version: 0.1.0', 'version: "1.0"');
    expect(() => parseSkillMd(bad)).toThrow(SkillMdParseError);
  });

  test('unknown confidence_tier is rejected', () => {
    const bad = VALID_MINIMAL.replace('confidence_tier: probabilistic', 'confidence_tier: unknown');
    expect(() => parseSkillMd(bad)).toThrow(SkillMdParseError);
  });

  test('prediction-error-reduction with target > baseline is rejected', () => {
    const bad = `${VALID_MINIMAL.replace(
      'confidence_tier: probabilistic',
      `confidence_tier: probabilistic
expected_prediction_error_reduction:
  baseline_composite_error: 0.1
  target_composite_error: 0.5
  trial_window: 10`,
    )}`;
    expect(() => parseSkillMd(bad)).toThrow(SkillMdParseError);
  });

  test('malformed id (uppercase) is rejected', () => {
    const bad = VALID_MINIMAL.replace('id: hello', 'id: Hello');
    expect(() => parseSkillMd(bad)).toThrow(SkillMdParseError);
  });
});
