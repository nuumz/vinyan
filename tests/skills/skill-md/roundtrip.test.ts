/**
 * SKILL.md round-trip invariants.
 *
 * For each fixture:
 *   1. parse(text) → record
 *   2. write(record) → text'
 *   3. parse(text') → record'
 *   Expect: record deep-equals record' (including unknownSections).
 *
 * Also: whitespace-only edits to the input must not change `contentHash`.
 */
import { describe, expect, test } from 'bun:test';

import { parseSkillMd } from '../../../src/skills/skill-md/parser.ts';
import { writeSkillMd } from '../../../src/skills/skill-md/writer.ts';

const FIXTURES: Record<string, string> = {
  minimal: `---
id: hello
name: Hello
version: 0.1.0
description: Minimal viable skill
confidence_tier: probabilistic
---

## Overview

Minimal.

## When to use

Never.

## Procedure

Do nothing.
`,

  fullHeuristic: `---
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

When the user selects a block of statements and the AST oracle confirms it
is a single contiguous region.

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
`,

  unknownSections: `---
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

## Examples

See tests.

## References

- https://example.com
`,

  signed: `---
id: hub/signed-skill
name: Signed Skill
version: 2.0.0
description: A signed skill from the hub
confidence_tier: heuristic
origin: hub
signature:
  algorithm: ed25519
  signer: did:example:123
  value: base64signature==
---

## Overview

x

## When to use

x

## Procedure

x
`,

  deterministic: `---
id: det/pinned
name: Pinned Skill
version: 1.0.0
description: A content-hash-bound skill
confidence_tier: deterministic
content_hash: sha256:${'a'.repeat(64)}
dep_cone_hashes:
  "src/a.ts": ${'b'.repeat(64)}
  "src/b.ts": ${'c'.repeat(64)}
---

## Overview

x

## When to use

x

## Procedure

x
`,
};

describe('SKILL.md round-trip', () => {
  for (const [name, text] of Object.entries(FIXTURES)) {
    test(`parse→write→parse preserves fixture '${name}'`, () => {
      const rec1 = parseSkillMd(text);
      const written = writeSkillMd(rec1);
      const rec2 = parseSkillMd(written);
      // contentHash must match between rounds because canonicalization is
      // the same in both directions.
      expect(rec2.contentHash).toBe(rec1.contentHash);
      expect(rec2.frontmatter).toEqual(rec1.frontmatter);
      expect(rec2.body).toEqual(rec1.body);
    });

    test(`write is idempotent for fixture '${name}'`, () => {
      const rec = parseSkillMd(text);
      const first = writeSkillMd(rec);
      const second = writeSkillMd(parseSkillMd(first));
      expect(second).toBe(first);
    });
  }
});

describe('SKILL.md contentHash stability under whitespace edits', () => {
  test('trailing spaces on every line do not change the hash', () => {
    const base = FIXTURES.minimal!;
    const baseRec = parseSkillMd(base);
    const dirty = base
      .split('\n')
      .map((l) => (l.length > 0 ? `${l}   ` : l))
      .join('\n');
    const dirtyRec = parseSkillMd(dirty);
    expect(dirtyRec.contentHash).toBe(baseRec.contentHash);
  });

  test('extra blank lines between sections do not change the hash', () => {
    const base = FIXTURES.minimal!;
    const baseRec = parseSkillMd(base);
    const padded = base.replace(/\n\n## /g, '\n\n\n\n## ');
    const paddedRec = parseSkillMd(padded);
    expect(paddedRec.contentHash).toBe(baseRec.contentHash);
  });

  test('CRLF line endings yield the same hash as LF', () => {
    const base = FIXTURES.fullHeuristic!;
    const baseRec = parseSkillMd(base);
    const crlf = base.replace(/\n/g, '\r\n');
    const crlfRec = parseSkillMd(crlf);
    expect(crlfRec.contentHash).toBe(baseRec.contentHash);
  });

  test('changing body content DOES change the hash', () => {
    const base = FIXTURES.minimal!;
    const baseRec = parseSkillMd(base);
    const changed = base.replace('Do nothing.', 'Do something.');
    const changedRec = parseSkillMd(changed);
    expect(changedRec.contentHash).not.toBe(baseRec.contentHash);
  });

  test('changing frontmatter (non-ignored field) DOES change the hash', () => {
    const base = FIXTURES.minimal!;
    const baseRec = parseSkillMd(base);
    const changed = base.replace('name: Hello', 'name: Hi');
    const changedRec = parseSkillMd(changed);
    expect(changedRec.contentHash).not.toBe(baseRec.contentHash);
  });

  test('adding content_hash field (after hashing) does not change the hash', () => {
    // content_hash is dropped from canonicalization, so adding it back
    // into the frontmatter must not re-hash.
    const base = FIXTURES.minimal!;
    const baseRec = parseSkillMd(base);
    const annotated = base.replace(
      'confidence_tier: probabilistic',
      `confidence_tier: probabilistic\ncontent_hash: ${baseRec.contentHash}`,
    );
    const annotatedRec = parseSkillMd(annotated);
    expect(annotatedRec.contentHash).toBe(baseRec.contentHash);
  });
});
