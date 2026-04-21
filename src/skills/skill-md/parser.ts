/**
 * SKILL.md parser — text → typed record.
 *
 * Steps:
 *   1. Split the leading YAML frontmatter block (delimited by `---`) from
 *      the markdown body. Absence of a frontmatter block is a hard error.
 *   2. Validate the frontmatter via `SkillMdFrontmatterSchema` (Zod).
 *   3. Walk H2 headings in the body. Required: Overview, When to use,
 *      Procedure. Optional: Preconditions, Files, Falsification. Any other
 *      H2 heading is preserved verbatim under `body.unknownSections` for
 *      lossless round-trip.
 *   4. Compute `contentHash` via `src/skills/skill-md/hash.ts`.
 *
 * Design notes:
 *   - The section map uses the normalized heading (lowercased, stripped of
 *     trailing colons) so "When to use" and "When To Use" both resolve.
 *   - The canonical body is reconstructed by the writer; the parser stores
 *     the raw text per section so the writer doesn't have to guess.
 */
import { parse as parseYaml } from 'yaml';

import { computeContentHash } from './hash.ts';
import {
  type SkillMdBody,
  type SkillMdFrontmatter,
  SkillMdFrontmatterSchema,
  SkillMdParseError,
  type SkillMdRecord,
} from './schema.ts';

const REQUIRED_SECTIONS: ReadonlyArray<{ key: keyof SkillMdBody; canonical: string; slug: string }> = [
  { key: 'overview', canonical: 'Overview', slug: 'overview' },
  { key: 'whenToUse', canonical: 'When to use', slug: 'when to use' },
  { key: 'procedure', canonical: 'Procedure', slug: 'procedure' },
];

const OPTIONAL_SECTIONS: ReadonlyArray<{ key: keyof SkillMdBody; canonical: string; slug: string }> = [
  { key: 'preconditions', canonical: 'Preconditions', slug: 'preconditions' },
  { key: 'files', canonical: 'Files', slug: 'files' },
  { key: 'falsification', canonical: 'Falsification', slug: 'falsification' },
];

const KNOWN_SLUGS = new Set<string>([...REQUIRED_SECTIONS.map((s) => s.slug), ...OPTIONAL_SECTIONS.map((s) => s.slug)]);

interface RawSection {
  heading: string;
  slug: string;
  startLine: number; // 1-indexed
  content: string;
}

/** Normalize a heading for lookup (lowercase, strip trailing colon/spaces). */
function slugify(heading: string): string {
  return heading.replace(/:\s*$/, '').trim().toLowerCase();
}

/** Split frontmatter and body. */
function splitFrontmatter(text: string): { yaml: string; bodyStart: number; body: string } {
  // Tolerate UTF-8 BOM.
  const normalized = text.replace(/^\uFEFF/, '');
  const lines = normalized.split(/\r?\n/);

  if (lines[0]?.trim() !== '---') {
    throw new SkillMdParseError('SKILL.md must start with YAML frontmatter delimited by `---`', 1);
  }

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    throw new SkillMdParseError('Unterminated YAML frontmatter (missing closing `---`)', 1);
  }

  const yaml = lines.slice(1, endIdx).join('\n');
  // Body begins on the line AFTER the closing `---`. `bodyStart` is 1-indexed
  // so the first body line reports as `endIdx + 2`.
  const bodyLines = lines.slice(endIdx + 1);
  // Strip a single leading blank line if present (canonical form emits one).
  if (bodyLines[0] === '') bodyLines.shift();
  return { yaml, bodyStart: endIdx + 2, body: bodyLines.join('\n') };
}

/** Walk the body and collect H2 sections. */
function collectSections(body: string, bodyStartLine: number): RawSection[] {
  const lines = body.split('\n');
  const sections: RawSection[] = [];
  let current: RawSection | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const match = /^##\s+(.+?)\s*$/.exec(raw);
    if (match) {
      if (current) {
        current.content = trimTrailingBlankLines(current.content);
        sections.push(current);
      }
      const heading = match[1]!;
      current = {
        heading,
        slug: slugify(heading),
        startLine: bodyStartLine + i,
        content: '',
      };
    } else if (current) {
      current.content += (current.content ? '\n' : '') + raw;
    }
    // Lines before the first H2 are discarded — canonical SKILL.md has no
    // prose above the first heading, and the writer won't emit any.
  }
  if (current) {
    current.content = trimTrailingBlankLines(current.content);
    sections.push(current);
  }
  return sections;
}

function trimTrailingBlankLines(text: string): string {
  return text.replace(/[\s\n]+$/g, '');
}

/** Parse the `## Files` bullet list into an array of relative paths. */
function parseFilesSection(content: string): string[] {
  const out: string[] = [];
  for (const rawLine of content.split('\n')) {
    const m = /^\s*[-*]\s+`?([^`]+?)`?\s*$/.exec(rawLine);
    if (!m) continue;
    const path = m[1]!.trim();
    if (path.length === 0) continue;
    out.push(path);
  }
  return out;
}

/** Parse the `## Falsification` section into a raw+structured view. */
function parseFalsificationSection(content: string): NonNullable<SkillMdBody['falsification']> {
  const blocks: Array<{ oracle: string; expect: string }> = [];
  // Match fenced ```vinyan-falsify blocks. Content is a simple `oracle: X`,
  // `expect: Y` line-based shape — the structured-section parser pulls
  // those out but leaves unknown keys for later layers.
  const fenceRe = /```vinyan-falsify\s*\n([\s\S]*?)\n```/g;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex loop
  while ((match = fenceRe.exec(content)) !== null) {
    const block = match[1] ?? '';
    const oracleLine = /^\s*oracle\s*:\s*(.+)$/m.exec(block);
    const expectLine = /^\s*expect\s*:\s*(.+)$/m.exec(block);
    if (oracleLine && expectLine) {
      blocks.push({ oracle: oracleLine[1]!.trim(), expect: expectLine[1]!.trim() });
    }
  }
  return { raw: content, blocks };
}

/** Parse a SKILL.md text string into a fully typed record. */
export function parseSkillMd(text: string): SkillMdRecord {
  const { yaml, bodyStart, body } = splitFrontmatter(text);

  let rawFrontmatter: unknown;
  try {
    rawFrontmatter = parseYaml(yaml, { prettyErrors: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SkillMdParseError(`Invalid YAML frontmatter: ${msg}`, 1);
  }
  if (rawFrontmatter === null || typeof rawFrontmatter !== 'object') {
    throw new SkillMdParseError('YAML frontmatter must be a mapping', 1);
  }

  const parsed = SkillMdFrontmatterSchema.safeParse(rawFrontmatter);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const msg = first ? `${first.path.join('.') || '<root>'}: ${first.message}` : 'Invalid frontmatter';
    throw new SkillMdParseError(`Frontmatter validation failed — ${msg}`, 1);
  }
  const frontmatter: SkillMdFrontmatter = parsed.data;

  const sections = collectSections(body, bodyStart);
  const bySlug = new Map<string, RawSection>();
  for (const s of sections) bySlug.set(s.slug, s);

  // Required sections
  for (const req of REQUIRED_SECTIONS) {
    if (!bySlug.has(req.slug)) {
      throw new SkillMdParseError(`Missing required section '## ${req.canonical}'`, bodyStart, req.canonical);
    }
  }

  const overview = bySlug.get('overview')!.content;
  const whenToUse = bySlug.get('when to use')!.content;
  const procedure = bySlug.get('procedure')!.content;
  const preconditionsSection = bySlug.get('preconditions');
  const filesSection = bySlug.get('files');
  const falsificationSection = bySlug.get('falsification');

  const out: SkillMdBody = {
    overview,
    whenToUse,
    procedure,
  };
  if (preconditionsSection) out.preconditions = preconditionsSection.content;
  if (filesSection) out.files = parseFilesSection(filesSection.content);
  if (falsificationSection) {
    out.falsification = parseFalsificationSection(falsificationSection.content);
  }

  // Unknown sections — preserve verbatim for round-trip.
  const unknownSections: Record<string, string> = {};
  for (const s of sections) {
    if (!KNOWN_SLUGS.has(s.slug)) {
      unknownSections[s.heading] = s.content;
    }
  }
  if (Object.keys(unknownSections).length > 0) {
    out.unknownSections = unknownSections;
  }

  const contentHash = computeContentHash(frontmatter, out);
  return { frontmatter, body: out, contentHash };
}
