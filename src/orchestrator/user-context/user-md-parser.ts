/**
 * USER.md parser + writer — text ↔ typed record.
 *
 * Format:
 *   ---
 *   version: 1.0.0
 *   profile: default
 *   ---
 *
 *   ## Section heading
 *   <!-- predicted_response: "the falsifiable claim" -->
 *   Section body.
 *
 *   ## Another section
 *   ...
 *
 * Design choices:
 *   - Only H2 headings start a section. H3+ inside a body is preserved verbatim.
 *   - The `<!-- predicted_response: "…" -->` comment is matched on the first
 *     non-blank line after the heading. Sections without one get
 *     `predictedResponse = ''` and `evidenceTier = 'speculative'` — the user
 *     hasn't committed a prediction yet, so tier-based ranking demotes it.
 *   - Round-trip invariant: `writeUserMd(parseUserMd(text))` canonicalizes
 *     whitespace/slug/ordering but preserves every section's heading, body,
 *     and prediction verbatim.
 *
 * Axiom anchors: A2 (speculative tier when no claim), A5 (tier carried per section).
 */
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import {
  type UserMdFrontmatter,
  UserMdFrontmatterSchema,
  UserMdParseError,
  type UserMdRecord,
  type UserMdSection,
} from './user-md-schema.ts';

// ---------------------------------------------------------------------------
// Slug derivation
// ---------------------------------------------------------------------------

/** ASCII-fold + kebab-case: "Communication style" → "communication-style". */
export function slugifyHeading(heading: string): string {
  const folded = heading
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .toLowerCase()
    .trim();
  const slug = folded.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  // Schema requires leading letter; if heading started with a digit/symbol,
  // prepend `s-` so the record is still storable.
  return /^[a-z]/.test(slug) ? slug : slug ? `s-${slug}` : 's';
}

// ---------------------------------------------------------------------------
// Frontmatter split — identical strategy to SKILL.md parser
// ---------------------------------------------------------------------------

interface SplitResult {
  yaml: string;
  body: string;
}

function splitFrontmatter(text: string): SplitResult {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');

  if (lines[0]?.trim() !== '---') {
    throw new UserMdParseError('USER.md must start with YAML frontmatter delimited by `---`', 1);
  }

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === '---') {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) {
    throw new UserMdParseError('Unterminated YAML frontmatter (missing closing `---`)', 1);
  }

  const yaml = lines.slice(1, endIdx).join('\n');
  const bodyLines = lines.slice(endIdx + 1);
  // Drop a single leading blank line if present (canonical form emits one).
  if (bodyLines[0] === '') bodyLines.shift();
  return { yaml, body: bodyLines.join('\n') };
}

// ---------------------------------------------------------------------------
// Section walking
// ---------------------------------------------------------------------------

interface RawSection {
  heading: string;
  startLine: number;
  contentLines: string[];
}

function collectSections(body: string): RawSection[] {
  const lines = body.split('\n');
  const sections: RawSection[] = [];
  let current: RawSection | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const match = /^##\s+(.+?)\s*$/.exec(raw);
    if (match) {
      if (current) sections.push(current);
      current = {
        heading: match[1]!,
        startLine: i + 1,
        contentLines: [],
      };
    } else if (current) {
      current.contentLines.push(raw);
    }
    // Lines before the first H2 (and H1 headings) are intentionally discarded;
    // canonical USER.md never carries prose above the first H2.
  }
  if (current) sections.push(current);
  return sections;
}

/**
 * Extract the `<!-- predicted_response: "…" -->` comment if it appears
 * on the first non-blank line of the section. Returns the prediction and
 * the remaining body (with the comment line stripped).
 */
function extractPredictedResponse(contentLines: string[]): { prediction: string; body: string } {
  // Find first non-blank line.
  let firstIdx = -1;
  for (let i = 0; i < contentLines.length; i++) {
    if ((contentLines[i] ?? '').trim().length > 0) {
      firstIdx = i;
      break;
    }
  }
  if (firstIdx === -1) {
    return { prediction: '', body: '' };
  }

  const first = contentLines[firstIdx]!;
  const match = /^\s*<!--\s*predicted_response\s*:\s*"(.*?)"\s*-->\s*$/.exec(first);
  if (!match) {
    return {
      prediction: '',
      body: trimSectionBody(contentLines.join('\n')),
    };
  }

  const remaining = [...contentLines.slice(0, firstIdx), ...contentLines.slice(firstIdx + 1)];
  return {
    prediction: match[1]!,
    body: trimSectionBody(remaining.join('\n')),
  };
}

function trimSectionBody(text: string): string {
  return text.replace(/^\n+/, '').replace(/\n+$/, '');
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/** Parse a USER.md text string into a typed record. */
export function parseUserMd(text: string): UserMdRecord {
  const { yaml, body } = splitFrontmatter(text);

  let rawFrontmatter: unknown;
  try {
    rawFrontmatter = parseYaml(yaml, { prettyErrors: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new UserMdParseError(`Invalid YAML frontmatter: ${msg}`, 1);
  }
  if (rawFrontmatter === null || typeof rawFrontmatter !== 'object') {
    throw new UserMdParseError('YAML frontmatter must be a mapping', 1);
  }

  const parsed = UserMdFrontmatterSchema.safeParse(rawFrontmatter);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const msg = first ? `${first.path.join('.') || '<root>'}: ${first.message}` : 'Invalid frontmatter';
    throw new UserMdParseError(`Frontmatter validation failed — ${msg}`, 1);
  }
  const frontmatter: UserMdFrontmatter = parsed.data;

  const rawSections = collectSections(body);
  const sections: UserMdSection[] = [];
  const seenSlugs = new Set<string>();

  for (const raw of rawSections) {
    const slug = slugifyHeading(raw.heading);
    if (seenSlugs.has(slug)) {
      throw new UserMdParseError(`Duplicate section slug '${slug}' (heading '${raw.heading}')`, raw.startLine);
    }
    seenSlugs.add(slug);

    const { prediction, body: sectionBody } = extractPredictedResponse(raw.contentLines);
    const hasPrediction = prediction.length > 0;
    sections.push({
      slug,
      heading: raw.heading,
      predictedResponse: prediction,
      body: sectionBody,
      evidenceTier: hasPrediction ? 'heuristic' : 'speculative',
      confidence: hasPrediction ? 0.7 : 0,
    });
  }

  return { frontmatter, sections };
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

/** Canonical YAML for the frontmatter: alphabetical keys, LF line endings. */
function canonicalFrontmatterYaml(frontmatter: UserMdFrontmatter): string {
  const yaml = stringifyYaml(frontmatter, {
    sortMapEntries: true,
    indent: 2,
    lineWidth: 0,
    defaultKeyType: 'PLAIN',
  });
  return yaml
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n+$/, '\n');
}

function renderSection(section: UserMdSection): string {
  const parts = [`## ${section.heading}`];
  if (section.predictedResponse.length > 0) {
    parts.push(`<!-- predicted_response: "${escapePredictionComment(section.predictedResponse)}" -->`);
  }
  const body = section.body.replace(/\r\n?/g, '\n').trim();
  if (body.length > 0) parts.push(body);
  return parts.join('\n');
}

/**
 * Escape a prediction string for embedding inside an HTML comment's double-quoted
 * value. We only care about two risks: `"` inside the value and `-->` breaking
 * the comment. Newlines collapse to a single space.
 */
function escapePredictionComment(prediction: string): string {
  return prediction.replace(/\r\n?/g, '\n').replace(/\n+/g, ' ').replace(/"/g, '\\"').replace(/-->/g, '--&gt;');
}

/** Serialize a record back to canonical USER.md text. */
export function writeUserMd(record: UserMdRecord): string {
  const yaml = canonicalFrontmatterYaml(record.frontmatter);
  const body = record.sections.map(renderSection).join('\n\n');
  // Match SKILL.md canonical shape: `---\n<yaml>---\n\n<body>\n`.
  return body.length > 0 ? `---\n${yaml}---\n\n${body}\n` : `---\n${yaml}---\n`;
}
