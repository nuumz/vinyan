/**
 * Memory Wiki — `[[wikilink]]` parser → typed edges.
 *
 * Recognized forms:
 *   [[target]]                       → edge_type='mentions'
 *   [[target|display]]               → edge_type='mentions', display ignored for edge
 *   [[target #anchor]]               → edge_type='mentions', anchor stripped
 *   [[supersedes:target]]            → edge_type='supersedes'
 *   [[cites:target]]                 → edge_type='cites'
 *   [[contradicts:target]]           → edge_type='contradicts'
 *   [[derived-from:target]]          → edge_type='derived-from'
 *   [[implements:target]]            → edge_type='implements'
 *   [[belongs-to:target]]            → edge_type='belongs-to'
 *
 * Targets are page ids OR aliases. Resolution is the caller's job — this
 * module emits raw `(targetSlug, edgeType)` tuples and unresolved targets
 * surface to lint as `broken-wikilink`.
 */
import { slugify } from './schema.ts';
import { WIKI_EDGE_TYPES, type WikiEdgeType } from './types.ts';

const WIKILINK_RE = /\[\[([^\]\n]+)\]\]/g;
const TYPE_PREFIX_RE = /^([a-z][a-z-]*):(.+)$/;

const EDGE_TYPE_SET: ReadonlySet<WikiEdgeType> = new Set(WIKI_EDGE_TYPES);

export interface ParsedWikilink {
  readonly target: string;
  readonly edgeType: WikiEdgeType;
  /** Display text (after `|`), or undefined when the link is a bare target. */
  readonly display?: string;
  /** The substring index where the wikilink starts in the input body. */
  readonly startIdx: number;
  readonly endIdx: number;
}

export function parseWikilinks(body: string): readonly ParsedWikilink[] {
  const out: ParsedWikilink[] = [];
  WIKILINK_RE.lastIndex = 0;
  for (let match = WIKILINK_RE.exec(body); match !== null; match = WIKILINK_RE.exec(body)) {
    const inner = (match[1] ?? '').trim();
    if (!inner) continue;
    const parsed = parseInner(inner);
    if (!parsed) continue;
    out.push({
      target: parsed.target,
      edgeType: parsed.edgeType,
      ...(parsed.display ? { display: parsed.display } : {}),
      startIdx: match.index,
      endIdx: match.index + match[0].length,
    });
  }
  return out;
}

function parseInner(inner: string): { target: string; edgeType: WikiEdgeType; display?: string } | null {
  // 1. split off display text
  let core = inner;
  let display: string | undefined;
  const pipeIdx = inner.indexOf('|');
  if (pipeIdx >= 0) {
    core = inner.slice(0, pipeIdx).trim();
    display = inner.slice(pipeIdx + 1).trim() || undefined;
  }
  // 2. strip anchor
  const hashIdx = core.indexOf('#');
  if (hashIdx >= 0) core = core.slice(0, hashIdx).trim();
  if (!core) return null;

  // 3. detect edge-type prefix
  const m = TYPE_PREFIX_RE.exec(core);
  let edgeType: WikiEdgeType = 'mentions';
  let targetRaw = core;
  if (m && EDGE_TYPE_SET.has(m[1] as WikiEdgeType)) {
    edgeType = m[1] as WikiEdgeType;
    targetRaw = (m[2] ?? '').trim();
  }
  if (!targetRaw) return null;

  return { target: normalizeTarget(targetRaw), edgeType, ...(display ? { display } : {}) };
}

/**
 * Normalize a target reference. We accept either:
 *   - a fully-qualified page id (e.g., `concept-epistemic-orchestration`)
 *     — passed through as-is when it already matches the slug shape;
 *   - a free-form title or alias — slugified. Resolution to a page id
 *     is the caller's responsibility (see `resolveTarget`).
 */
export function normalizeTarget(raw: string): string {
  // If it already looks like a slug (lowercase, hyphenated, with a known
  // page-type prefix), keep it; otherwise slugify the title.
  if (/^[a-z][a-z0-9-]*$/.test(raw)) return raw;
  return slugify(raw);
}
