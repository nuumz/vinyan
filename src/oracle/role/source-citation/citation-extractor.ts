/**
 * Citation extractor — pure markdown parser for the source-citation oracle.
 *
 * Recognized patterns:
 *
 *   1. Markdown footnote refs:    `Some claim.[^id]`
 *      Definitions:               `[^id]: <resolves-to>`
 *      where `<resolves-to>` is free-form (URL, doi, hash:..., …) — the
 *      oracle judges set membership, not format.
 *
 *   2. Inline hash refs:           `Some claim. [hash:abc123def]`
 *      Resolves to the value after `hash:`.
 *
 * Both forms may appear in the same document. The extractor is line-based
 * (paragraph granularity) — a "claim" is any non-empty body line that is
 * not a heading, list-marker, blockquote, code-block, or footnote
 * definition. The oracle pushes the writer to keep one claim per line; in
 * practice the synthesis step's prompt asks for that.
 *
 * Sentence-granularity extraction was considered and rejected for A2:
 * abbreviation-aware sentence segmentation is fragile and the false-
 * positive cost (oracle flags trivial throwaways) outweighs the
 * granularity benefit. Operators wanting tighter scrutiny should adjust
 * the protocol's prompt to emit one claim per line.
 *
 * Pure & deterministic (A3). No regex catastrophes — every pattern is
 * anchored and bounded.
 */

const FOOTNOTE_REF_RX = /\[\^([\w-]+)\]/g;
const INLINE_HASH_RX = /\[hash:([\w./:=+-]+)\]/g;
const FOOTNOTE_DEF_RX = /^\[\^([\w-]+)\]:\s*(.+?)\s*$/;
const HEADING_RX = /^#{1,6}\s/;
const LIST_MARKER_RX = /^(\s*)([-*+]|\d+\.)\s/;
const BLOCKQUOTE_RX = /^>\s?/;
const CODE_FENCE_RX = /^```/;

export interface ClaimLine {
  /** Original line text (with citation markers stripped for readability). */
  readonly text: string;
  /** 1-indexed line number in the input. */
  readonly lineNumber: number;
  /**
   * Citation tokens referenced by this claim. Each entry is either
   *   - `'^id'` for a markdown footnote reference, or
   *   - `'hash:value'` for an inline hash reference (verbatim, including prefix).
   *
   * The extractor does not resolve footnotes; the oracle resolves +
   * checks set membership. Keeping the resolver out of the extractor
   * lets the same parsed structure feed multiple oracles (e.g. a future
   * "load-bearing claims must come from ≥2 sources" oracle).
   */
  readonly citations: readonly string[];
}

export interface ExtractedCitations {
  readonly claims: readonly ClaimLine[];
  /** Footnote definitions: id → free-form `resolvesTo` string. */
  readonly footnotes: ReadonlyMap<string, string>;
  /** Inline `hash:X` values referenced anywhere in the body. */
  readonly inlineHashes: ReadonlySet<string>;
}

/**
 * Parse `text` and return every claim line + every footnote definition.
 * Code blocks (between triple-backtick fences) are stripped before claim
 * extraction so a sample-code section that happens to contain `[^id]`
 * doesn't fabricate uncited claims.
 */
export function extractCitations(text: string): ExtractedCitations {
  const lines = text.split(/\r?\n/);
  const claims: ClaimLine[] = [];
  const footnotes = new Map<string, string>();
  const inlineHashes = new Set<string>();
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const lineNumber = i + 1;

    if (CODE_FENCE_RX.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const defMatch = FOOTNOTE_DEF_RX.exec(raw);
    if (defMatch) {
      const [, id, value] = defMatch;
      // Last write wins on duplicate ids — matches CommonMark behavior.
      footnotes.set(id!, value!);
      continue;
    }

    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (HEADING_RX.test(trimmed)) continue;
    if (BLOCKQUOTE_RX.test(trimmed)) continue;
    if (LIST_MARKER_RX.test(raw)) continue; // structural — list items are not paragraph claims

    const cites: string[] = [];
    for (const m of raw.matchAll(FOOTNOTE_REF_RX)) {
      cites.push(`^${m[1]}`);
    }
    for (const m of raw.matchAll(INLINE_HASH_RX)) {
      const value = m[1]!;
      cites.push(`hash:${value}`);
      inlineHashes.add(value);
    }

    // Strip both citation patterns for the human-readable claim text.
    const cleaned = raw.replace(FOOTNOTE_REF_RX, '').replace(INLINE_HASH_RX, '').trim();

    claims.push({ text: cleaned, lineNumber, citations: cites });
  }

  return { claims, footnotes, inlineHashes };
}

/**
 * Resolve a citation token to its underlying value, suitable for set
 * membership against the gather step's recorded hashes.
 *
 *   - `'^id'`        → footnote definition's resolvesTo string, or `undefined` if no definition exists.
 *   - `'hash:value'` → `'value'` (verbatim).
 *
 * `undefined` means "the citation references a footnote that the
 * synthesis step never defined". The oracle treats that as an unknown
 * citation (more diagnostic than uncited — the writer tried to cite,
 * but pointed at nothing).
 */
export function resolveCitation(token: string, footnotes: ReadonlyMap<string, string>): string | undefined {
  if (token.startsWith('hash:')) return token.slice('hash:'.length);
  if (token.startsWith('^')) {
    const id = token.slice(1);
    return footnotes.get(id);
  }
  return undefined;
}
