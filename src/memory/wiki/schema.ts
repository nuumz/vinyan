/**
 * Memory Wiki — schema constants & frontmatter utilities.
 *
 * Page ids, frontmatter shape, page-type slug rules, and the
 * human-protected section markers live here so the writer/validator and
 * the vault don't redefine them.
 *
 * The deterministic id rule (`<type>-<slug>`) is part of the contract:
 * upserts on (profile, type, title) collapse to the same id, so two
 * sessions can write to the same `concept-epistemic-orchestration` page
 * without a coordination layer.
 */
import { createHash } from 'node:crypto';
import type { ConfidenceTier } from '../../core/confidence-tier.ts';
import type { WikiLifecycle, WikiPageType, WikiSourceRef } from './types.ts';

// ── Schema version ──────────────────────────────────────────────────────

export const MEMORY_WIKI_SCHEMA_VERSION = 1;

// ── Page-id derivation ──────────────────────────────────────────────────

const SLUG_REPLACE_RE = /[^a-z0-9]+/g;
const SLUG_TRIM_RE = /(^-+)|(-+$)/g;

export function slugify(text: string): string {
  return text
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[̀-ͯ]/g, '')
    .replace(SLUG_REPLACE_RE, '-')
    .replace(SLUG_TRIM_RE, '')
    .slice(0, 80);
}

/**
 * Derive a deterministic id from (type, title). Stable across processes.
 * When the slug collides (very long titles truncated), we tack on the
 * first 8 chars of sha256(title) so two distinct titles can't share one id.
 */
export function derivePageId(type: WikiPageType, title: string): string {
  const slug = slugify(title);
  if (slug.length === 0) {
    return `${type}-${createHash('sha256').update(title).digest('hex').slice(0, 12)}`;
  }
  if (title.length > 80) {
    const tail = createHash('sha256').update(title).digest('hex').slice(0, 8);
    return `${type}-${slug}-${tail}`;
  }
  return `${type}-${slug}`;
}

/**
 * Content-addressed source ID. PURE function of `(kind, contentHash)` —
 * same content + same kind ⇒ same id, idempotent across re-ingestions.
 *
 * Earlier versions mixed `createdAt` into the hash so two emits at
 * distinct microtask timestamps produced distinct ids even with byte-
 * identical bodies (verified in the L1 live walkthrough — every HTTP
 * archive yielded ~2 source rows because `session-manager.ts:467` and
 * `server.ts:4850` both emitted, and each emit ran the bridge handler
 * at a slightly different `Date.now()`). Removing `createdAt` from the
 * id derivation makes content-identical re-ingest a no-op via
 * `getSourceById` dedupe.
 *
 * `createdAt` migrates to a column for ordering only. Old rows with
 * time-mixed ids stay in the DB (orphan from new-content lookups, but
 * still queryable / surfaced by the consolidation idle-archive sweep).
 *
 * The `_legacyCreatedAt` parameter is kept as an optional positional so
 * callers that haven't been migrated still type-check; new code must
 * stop passing it.
 */
export function deriveSourceId(
  kind: string,
  contentHash: string,
  _legacyCreatedAt?: number,
): string {
  return createHash('sha256').update(`${kind}|${contentHash}`).digest('hex');
}

export function computeBodyHash(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

// ── Frontmatter ─────────────────────────────────────────────────────────

export const FRONTMATTER_FENCE = '---';

export interface PageFrontmatter {
  id: string;
  type: WikiPageType;
  title: string;
  aliases: string[];
  tags: string[];
  sourceHashes: string[];
  evidenceTier: ConfidenceTier;
  confidence: number;
  lifecycle: WikiLifecycle;
  createdAt: number;
  updatedAt: number;
  validUntil?: number;
  protectedSections: string[];
  profile: string;
  bodyHash: string;
  schemaVersion: number;
}

/**
 * Render frontmatter as a YAML-like block. We intentionally do NOT pull
 * a YAML library — the schema is fixed and the writer controls every
 * field, so a deterministic stringifier is simpler and less injection-prone.
 *
 * Strings are JSON-quoted; numbers and booleans render bare. Arrays render
 * with bracket notation. Order is canonical so two writes of the same
 * page produce identical bytes.
 */
export function renderFrontmatter(fm: PageFrontmatter): string {
  const lines: string[] = [FRONTMATTER_FENCE];
  lines.push(`schemaVersion: ${fm.schemaVersion}`);
  lines.push(`id: ${quoteIfNeeded(fm.id)}`);
  lines.push(`type: ${fm.type}`);
  lines.push(`title: ${JSON.stringify(fm.title)}`);
  lines.push(`profile: ${quoteIfNeeded(fm.profile)}`);
  lines.push(`aliases: ${stringifyArray(fm.aliases)}`);
  lines.push(`tags: ${stringifyArray(fm.tags)}`);
  lines.push(`sourceHashes: ${stringifyArray(fm.sourceHashes)}`);
  lines.push(`evidenceTier: ${fm.evidenceTier}`);
  lines.push(`confidence: ${fm.confidence}`);
  lines.push(`lifecycle: ${fm.lifecycle}`);
  lines.push(`createdAt: ${fm.createdAt}`);
  lines.push(`updatedAt: ${fm.updatedAt}`);
  if (fm.validUntil !== undefined) lines.push(`validUntil: ${fm.validUntil}`);
  lines.push(`protectedSections: ${stringifyArray(fm.protectedSections)}`);
  lines.push(`bodyHash: ${quoteIfNeeded(fm.bodyHash)}`);
  lines.push(FRONTMATTER_FENCE);
  return lines.join('\n');
}

const SAFE_BARE = /^[A-Za-z0-9_./-]+$/;

function quoteIfNeeded(s: string): string {
  if (SAFE_BARE.test(s)) return s;
  return JSON.stringify(s);
}

function stringifyArray(items: readonly string[]): string {
  if (items.length === 0) return '[]';
  return `[${items.map((s) => JSON.stringify(s)).join(', ')}]`;
}

// ── Frontmatter parser ──────────────────────────────────────────────────

/**
 * Best-effort parser that recovers fields from a previously-rendered
 * frontmatter block. Used by the vault when re-reading pages.
 *
 * Returns `null` when the block is missing or unparseable — callers fall
 * back to "this file is human-edited free-form, don't trust the
 * frontmatter".
 */
export function parseFrontmatter(content: string): { fm: Partial<PageFrontmatter>; body: string } | null {
  if (!content.startsWith(FRONTMATTER_FENCE)) return null;
  const closeIdx = content.indexOf(`\n${FRONTMATTER_FENCE}`, FRONTMATTER_FENCE.length);
  if (closeIdx === -1) return null;

  const block = content.slice(FRONTMATTER_FENCE.length + 1, closeIdx);
  const body = content.slice(closeIdx + FRONTMATTER_FENCE.length + 1).replace(/^\n/, '');

  const fm: Partial<PageFrontmatter> = {};
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    assignFrontmatterField(fm, key, value);
  }
  return { fm, body };
}

function assignFrontmatterField(fm: Partial<PageFrontmatter>, key: string, raw: string): void {
  switch (key) {
    case 'schemaVersion':
      fm.schemaVersion = Number.parseInt(raw, 10);
      break;
    case 'id':
      fm.id = unquote(raw);
      break;
    case 'type':
      fm.type = raw as WikiPageType;
      break;
    case 'title':
      fm.title = unquote(raw);
      break;
    case 'profile':
      fm.profile = unquote(raw);
      break;
    case 'aliases':
      fm.aliases = parseStringArray(raw);
      break;
    case 'tags':
      fm.tags = parseStringArray(raw);
      break;
    case 'sourceHashes':
      fm.sourceHashes = parseStringArray(raw);
      break;
    case 'evidenceTier':
      fm.evidenceTier = raw as ConfidenceTier;
      break;
    case 'confidence':
      fm.confidence = Number.parseFloat(raw);
      break;
    case 'lifecycle':
      fm.lifecycle = raw as WikiLifecycle;
      break;
    case 'createdAt':
      fm.createdAt = Number.parseInt(raw, 10);
      break;
    case 'updatedAt':
      fm.updatedAt = Number.parseInt(raw, 10);
      break;
    case 'validUntil':
      fm.validUntil = Number.parseInt(raw, 10);
      break;
    case 'protectedSections':
      fm.protectedSections = parseStringArray(raw);
      break;
    case 'bodyHash':
      fm.bodyHash = unquote(raw);
      break;
    default:
      break;
  }
}

function unquote(raw: string): string {
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    try {
      return JSON.parse(raw) as string;
    } catch {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

function parseStringArray(raw: string): string[] {
  if (raw === '[]') return [];
  // Tolerate either bracket form or comma-separated bare list.
  if (raw.startsWith('[') && raw.endsWith(']')) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed.map((x) => String(x));
    } catch {
      /* fall through */
    }
  }
  return raw
    .split(',')
    .map((s) => unquote(s.trim()))
    .filter(Boolean);
}

// ── Human-protected section markers ─────────────────────────────────────

/**
 * Sections wrapped between `<!-- human:protected:NAME -->` and
 * `<!-- /human:protected:NAME -->` are preserved verbatim across writes.
 *
 * The marker is intentionally a comment so it renders cleanly in
 * Obsidian and standard markdown viewers.
 */
const PROTECTED_RE = /<!--\s*human:protected:([a-zA-Z0-9_-]+)\s*-->([\s\S]*?)<!--\s*\/human:protected:\1\s*-->/g;

export interface ProtectedSection {
  readonly name: string;
  readonly content: string;
  readonly startIdx: number;
  readonly endIdx: number;
}

export function extractProtectedSections(body: string): ProtectedSection[] {
  const out: ProtectedSection[] = [];
  PROTECTED_RE.lastIndex = 0;
  for (let match = PROTECTED_RE.exec(body); match !== null; match = PROTECTED_RE.exec(body)) {
    out.push({
      name: match[1] ?? '',
      content: match[0],
      startIdx: match.index,
      endIdx: match.index + match[0].length,
    });
  }
  return out;
}

/**
 * Merge a proposed body with previously-saved protected sections. If the
 * proposed body already contains the protected blocks, they are kept;
 * if it's missing them, the existing blocks are appended back in order.
 *
 * Returns `null` when the proposal *modifies* the inside of an existing
 * protected block — the caller treats that as a write rejection.
 */
export function mergeProtectedSections(existingBody: string, proposedBody: string): { merged: string } | null {
  const existing = extractProtectedSections(existingBody);
  if (existing.length === 0) return { merged: proposedBody };

  const proposed = extractProtectedSections(proposedBody);
  const proposedByName = new Map(proposed.map((p) => [p.name, p]));

  for (const block of existing) {
    const found = proposedByName.get(block.name);
    if (found && found.content !== block.content) {
      return null; // forbidden modification
    }
  }

  if (proposed.length === existing.length && proposed.every((p, i) => p.content === existing[i]?.content)) {
    return { merged: proposedBody };
  }

  // Rebuild: keep proposed body, append any missing blocks at the bottom.
  let merged = proposedBody;
  for (const block of existing) {
    if (!proposedByName.has(block.name)) {
      merged = `${merged.replace(/\s+$/, '')}\n\n${block.content}\n`;
    }
  }
  return { merged };
}

// ── Citation helpers ────────────────────────────────────────────────────

/** Render a `[Source: <hash-prefix>]` inline citation. */
export function renderCitation(ref: WikiSourceRef): string {
  return `[Source: ${ref.contentHash.slice(0, 8)}]`;
}
