/**
 * Compaction summary verifier (G7 — A1 enforcement on LLM-generated summaries).
 *
 * Background: dual-track compaction in `transcript-compactor.ts` already keeps
 * evidence turns immutable (A4) and lets a caller summarize the narrative
 * turns. The current default summary is deterministic ("[Compacted: N turns
 * removed]") so it cannot fabricate facts. But once the deprecated LLM-based
 * `compactionLlm` path returns — or any caller ships an LLM-written summary
 * — A1 (Epistemic Separation) demands that the LLM not be the verifier of
 * its own output.
 *
 * This module is the verifier: extract claims from the summary, look them up
 * against an EXTERNAL fact source (world-graph), reject the summary if more
 * than `maxOrphanRatio` of claims are unsupported. The caller falls back to
 * deterministic truncation when verification fails.
 *
 * The verifier is intentionally:
 *   - Pure (no LLM call) — runs in the orchestrator path under A3.
 *   - Decoupled from world-graph (DI via `factLookup`) — testable and reusable
 *     for any text that asserts file/symbol claims.
 *   - Conservative — when a regex match looks like a file path or symbol but
 *     the fact source has no matching record, it counts as an orphan.
 *
 * Axioms: A1 (Epistemic Separation — generation ≠ verification), A4 (facts
 * grounded in content-addressed truth, not LLM rumor).
 */

/** A claim extracted from a summary — typically a file path or symbol identifier. */
export interface SummaryClaim {
  /** The matched text. */
  text: string;
  /** What kind of identifier we matched. Used for diagnostics, not enforcement. */
  kind: 'file-path' | 'symbol';
  /** Character offset in the original summary (for diagnostics). */
  offset: number;
}

export interface VerificationResult {
  /** True when fewer than `maxOrphanRatio` of claims are orphans. */
  verified: boolean;
  /** orphans / claims. Returns 0 when there are no claims (vacuously verified). */
  orphanRatio: number;
  /** All claims extracted from the summary. */
  claims: SummaryClaim[];
  /** Subset of `claims` that the fact source did NOT recognize. */
  orphans: SummaryClaim[];
  /** Threshold used for the `verified` decision. */
  threshold: number;
}

export interface VerifyOptions {
  /**
   * Caller-provided lookup against the canonical fact source (typically
   * world-graph / hot-fact-index). Returns true when the claim matches a known
   * file path, symbol, or fact. The verifier never throws if `factLookup`
   * throws — an exception is treated as `false` (orphan).
   */
  factLookup: (claim: string) => boolean;
  /**
   * Maximum tolerated orphan ratio. Default 0.10 — a summary may invent at
   * most ~10% spurious references before it's rejected.
   */
  maxOrphanRatio?: number;
}

const DEFAULT_MAX_ORPHAN_RATIO = 0.1;

/**
 * Match anything that looks like a relative file path:
 *   - 1+ path segments separated by `/`
 *   - last segment carries an extension (`.ts`, `.tsx`, `.md`, `.json`, etc.)
 *
 * Tightened to require AT LEAST one slash so we don't flag bare extensions
 * inside prose (e.g. "fixed the .ts errors") and require the segments to
 * look like identifier-ish characters so prose punctuation doesn't match.
 */
const FILE_PATH_PATTERN = /(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+\.[A-Za-z0-9]+/g;

/**
 * Match TypeScript/JS-style identifiers used in conventional API references:
 *   - `Class.method` or `module.symbol`
 *   - PascalCase or camelCase with at least one dot OR PascalCase alone
 *
 * We keep the symbol regex intentionally conservative — false positives mean
 * extra orphan checks (still cheap), but false negatives mean the verifier
 * misses a fabricated reference.
 */
const SYMBOL_PATTERN = /\b[A-Z][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+\b/g;

/**
 * Extract file-path-like and symbol-like claims from `summary`. Order is the
 * scan order (left-to-right). Duplicates are collapsed (first occurrence
 * wins) so a summary that mentions the same file 5 times pays one lookup.
 */
export function extractClaims(summary: string): SummaryClaim[] {
  const seen = new Set<string>();
  const out: SummaryClaim[] = [];

  for (const match of summary.matchAll(FILE_PATH_PATTERN)) {
    const text = match[0];
    if (seen.has(text)) continue;
    seen.add(text);
    out.push({ text, kind: 'file-path', offset: match.index ?? 0 });
  }

  for (const match of summary.matchAll(SYMBOL_PATTERN)) {
    const text = match[0];
    // Don't double-count something already matched as a file path.
    if (seen.has(text)) continue;
    seen.add(text);
    out.push({ text, kind: 'symbol', offset: match.index ?? 0 });
  }

  return out;
}

/**
 * Verify a compaction summary against the canonical fact source.
 *
 * Behaviour:
 *   - No claims → `verified: true, orphanRatio: 0` (vacuously fine; the
 *     deterministic summary fits this case).
 *   - Some claims → look each up via `factLookup`. Count orphans. Compare
 *     ratio against `maxOrphanRatio`.
 *   - `factLookup` throws → that claim counts as an orphan. The verifier
 *     never propagates the exception so the caller's compaction loop is
 *     robust to a transient world-graph error.
 */
export function verifyCompactionSummary(summary: string, options: VerifyOptions): VerificationResult {
  const threshold = options.maxOrphanRatio ?? DEFAULT_MAX_ORPHAN_RATIO;
  const claims = extractClaims(summary);

  if (claims.length === 0) {
    return { verified: true, orphanRatio: 0, claims, orphans: [], threshold };
  }

  const orphans: SummaryClaim[] = [];
  for (const claim of claims) {
    let known = false;
    try {
      known = options.factLookup(claim.text);
    } catch {
      known = false;
    }
    if (!known) orphans.push(claim);
  }

  const orphanRatio = orphans.length / claims.length;
  return {
    verified: orphanRatio <= threshold,
    orphanRatio,
    claims,
    orphans,
    threshold,
  };
}
