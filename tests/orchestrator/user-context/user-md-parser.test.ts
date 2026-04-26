/**
 * Tests for USER.md parser + writer.
 *
 * The parser establishes three invariants this suite pins:
 *   - Frontmatter Zod validation + error shape.
 *   - H2-only section walking; H3 is body content, not a new section.
 *   - Missing `predicted_response` comment sets the section to speculative (A2).
 * Plus a round-trip: `writeUserMd(parseUserMd(text))` re-parses into the
 * same typed record.
 */
import { describe, expect, test } from 'bun:test';

import { parseUserMd, slugifyHeading, writeUserMd } from '../../../src/orchestrator/user-context/user-md-parser.ts';
import { UserMdParseError } from '../../../src/orchestrator/user-context/user-md-schema.ts';

const SAMPLE = `---
version: 1.0.0
profile: default
---

## Communication style
<!-- predicted_response: "User prefers terse replies without preamble" -->
Short, punchy replies. Skip filler. Lead with the answer.

## Language
<!-- predicted_response: "User writes in Thai; code in English" -->
Bilingual Thai/English. Code, commits, and identifier names in English.
Comments in code in English. Thai for conversational replies.

## Code style
<!-- predicted_response: "Prefers TypeScript strict mode, Bun, Biome" -->
TypeScript strict; no \`any\`. Bun ecosystem (not npm/yarn). Biome for lint+format.
`;

describe('parseUserMd', () => {
  test('parses frontmatter + all H2 sections', () => {
    const record = parseUserMd(SAMPLE);
    expect(record.frontmatter.version).toBe('1.0.0');
    expect(record.frontmatter.profile).toBe('default');
    expect(record.sections).toHaveLength(3);
    const slugs = record.sections.map((s) => s.slug);
    expect(slugs).toEqual(['communication-style', 'language', 'code-style']);
  });

  test('extracts predicted_response comment per section', () => {
    const record = parseUserMd(SAMPLE);
    expect(record.sections[0]!.predictedResponse).toBe('User prefers terse replies without preamble');
    expect(record.sections[1]!.predictedResponse).toBe('User writes in Thai; code in English');
    expect(record.sections[2]!.predictedResponse).toBe('Prefers TypeScript strict mode, Bun, Biome');
  });

  test('sections with predictions default to heuristic tier', () => {
    const record = parseUserMd(SAMPLE);
    for (const section of record.sections) {
      expect(section.evidenceTier).toBe('heuristic');
      expect(section.confidence).toBeCloseTo(0.7);
    }
  });

  test('section without a predicted_response comment is speculative + empty prediction', () => {
    const text = `---
version: 1.0.0
profile: default
---

## Unspecified preferences
Body-only section without a committed prediction. Should parse, not throw.
`;
    const record = parseUserMd(text);
    expect(record.sections).toHaveLength(1);
    const section = record.sections[0]!;
    expect(section.predictedResponse).toBe('');
    expect(section.evidenceTier).toBe('speculative');
    expect(section.confidence).toBe(0);
    expect(section.body).toContain('Body-only section');
  });

  test('H3 headings inside a section are preserved as body, not promoted to sections', () => {
    const text = `---
version: 1.0.0
---

## Communication style
<!-- predicted_response: "Terse replies" -->
Main prose.

### Sub-heading

Sub-body content.
`;
    const record = parseUserMd(text);
    expect(record.sections).toHaveLength(1);
    expect(record.sections[0]!.body).toContain('### Sub-heading');
    expect(record.sections[0]!.body).toContain('Sub-body content');
  });

  test('rejects missing frontmatter', () => {
    expect(() => parseUserMd('## No frontmatter\nbody')).toThrow(UserMdParseError);
  });

  test('rejects unterminated frontmatter', () => {
    expect(() =>
      parseUserMd(`---
version: 1.0.0

## Oops
body
`),
    ).toThrow(UserMdParseError);
  });

  test('rejects malformed version in frontmatter', () => {
    const bad = `---
version: not-a-semver
---

## Foo
<!-- predicted_response: "x" -->
body
`;
    expect(() => parseUserMd(bad)).toThrow(UserMdParseError);
  });

  test('rejects duplicate section slugs', () => {
    const text = `---
version: 1.0.0
---

## Style
<!-- predicted_response: "a" -->
body1

## STYLE
<!-- predicted_response: "b" -->
body2
`;
    expect(() => parseUserMd(text)).toThrow(UserMdParseError);
  });

  test('writeUserMd produces canonical text that round-trips', () => {
    const record = parseUserMd(SAMPLE);
    const rendered = writeUserMd(record);
    const reparsed = parseUserMd(rendered);
    expect(reparsed.frontmatter).toEqual(record.frontmatter);
    expect(reparsed.sections.length).toEqual(record.sections.length);
    for (let i = 0; i < record.sections.length; i++) {
      const a = record.sections[i]!;
      const b = reparsed.sections[i]!;
      expect(b.slug).toEqual(a.slug);
      expect(b.heading).toEqual(a.heading);
      expect(b.predictedResponse).toEqual(a.predictedResponse);
      expect(b.body.trim()).toEqual(a.body.trim());
      expect(b.evidenceTier).toEqual(a.evidenceTier);
    }
  });

  test('writeUserMd omits the comment line for sections without a prediction', () => {
    const record = parseUserMd(`---
version: 1.0.0
---

## Empty
plain body
`);
    const rendered = writeUserMd(record);
    expect(rendered).not.toContain('predicted_response');
    expect(rendered).toContain('## Empty');
    expect(rendered).toContain('plain body');
  });
});

describe('slugifyHeading', () => {
  test('kebab-cases multi-word headings', () => {
    expect(slugifyHeading('Communication style')).toBe('communication-style');
    expect(slugifyHeading('Code style & formatting')).toBe('code-style-formatting');
  });

  test('strips diacritics and lowercases', () => {
    expect(slugifyHeading('Naïve Approach')).toBe('naive-approach');
  });

  test('prefixes headings that start with digits', () => {
    expect(slugifyHeading('10x engineering')).toMatch(/^s-/);
  });
});
