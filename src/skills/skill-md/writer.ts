/**
 * SKILL.md writer — typed record → canonical text.
 *
 * Canonical form (required for the round-trip invariant):
 *   - Frontmatter keys emitted in **alphabetical order**.
 *   - Body sections emitted in fixed order:
 *       Overview → When to use → Preconditions → Procedure → Files →
 *       Falsification → unknownSections (alphabetical by heading).
 *   - LF-only line endings; no trailing whitespace on any line.
 *   - Single blank line between sections; no double blanks.
 *   - A single terminating newline at EOF.
 *
 * The writer is invertible: `parseSkillMd(writeSkillMd(parseSkillMd(text)))`
 * deep-equals `parseSkillMd(text)` (except for `contentHash`, which is
 * whitespace-normalized and therefore stable).
 */
import { stringify as stringifyYaml } from 'yaml';

import type { SkillMdBody, SkillMdFrontmatter, SkillMdRecord } from './schema.ts';

/** Canonical YAML serialization: alphabetical keys, 2-space indent, LF. */
export function canonicalFrontmatterYaml(frontmatter: SkillMdFrontmatter): string {
  // yaml@2 sortMapEntries sorts top-level keys (and nested, lexicographically).
  const yaml = stringifyYaml(frontmatter, {
    sortMapEntries: true,
    indent: 2,
    lineWidth: 0, // never auto-wrap strings
    defaultKeyType: 'PLAIN',
  });
  return stripTrailingSpaces(yaml).replace(/\n+$/, '\n');
}

/** Reconstruct the markdown body in canonical section order. */
export function canonicalBodyMarkdown(body: SkillMdBody): string {
  const sections: string[] = [];
  sections.push(renderSection('Overview', body.overview));
  sections.push(renderSection('When to use', body.whenToUse));
  if (body.preconditions !== undefined) {
    sections.push(renderSection('Preconditions', body.preconditions));
  }
  sections.push(renderSection('Procedure', body.procedure));
  if (body.files && body.files.length > 0) {
    sections.push(renderSection('Files', body.files.map((f) => `- ${f}`).join('\n')));
  }
  if (body.falsification) {
    sections.push(renderSection('Falsification', body.falsification.raw));
  }
  if (body.unknownSections) {
    const headings = Object.keys(body.unknownSections).sort();
    for (const h of headings) {
      sections.push(renderSection(h, body.unknownSections[h] ?? ''));
    }
  }
  return sections.join('\n\n');
}

function renderSection(heading: string, content: string): string {
  const normalized = normalizeSectionBody(content);
  return normalized.length > 0 ? `## ${heading}\n\n${normalized}` : `## ${heading}`;
}

/**
 * Normalize a section body:
 *   - CRLF → LF
 *   - strip trailing whitespace per line
 *   - collapse 2+ blank lines → 1
 *   - trim leading/trailing blank lines
 */
function normalizeSectionBody(text: string): string {
  const lf = text.replace(/\r\n?/g, '\n');
  const trimmed = lf
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n');
  const collapsed = trimmed.replace(/\n{3,}/g, '\n\n');
  return collapsed.replace(/^\n+/, '').replace(/\n+$/, '');
}

function stripTrailingSpaces(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n');
}

/** Serialize a full record back to canonical SKILL.md text. */
export function writeSkillMd(record: SkillMdRecord): string {
  const yaml = canonicalFrontmatterYaml(record.frontmatter);
  const body = canonicalBodyMarkdown(record.body);
  // yaml already ends with '\n'; wrap in `---` fences and append a blank
  // line before the body, then a single trailing newline at EOF.
  return `---\n${yaml}---\n\n${body}\n`;
}
