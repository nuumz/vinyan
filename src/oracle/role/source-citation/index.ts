/**
 * Source-citation oracle — Phase A2 deterministic verifier for the
 * `researcher.investigate` protocol's `verify-citations` step.
 *
 * Contract: every claim line in the synthesis output must carry ≥1
 * citation, and every cited token must resolve to a hash recorded by
 * the prior `gather` step (passed in as `gatheredHashes`).
 *
 * Returns a structured verdict — the role-protocol driver consumes the
 * `verified` boolean for gate decisions; the diagnostic arrays surface
 * to operators via the `role_protocol_run` audit table so a researcher
 * sees *which* claim lacked a citation, not just "step failed."
 *
 * Pure (A3). In-process. No subprocess wrapping for A2 — the driver
 * calls `verifySourceCitations` directly. A future phase-verify
 * integration may wrap this in the standard stdin/stdout oracle entry,
 * but that's ceremony orthogonal to the protocol.
 *
 * The oracle is deterministic and side-effect-free, so the same input
 * always produces the same verdict — important for A8 trace replay.
 */

import { extractCitations, resolveCitation } from './citation-extractor.ts';

export interface SourceCitationInput {
  readonly synthesisText: string;
  /**
   * The set of values the gather step recorded as "consulted." Format is
   * opaque to the oracle — URLs, content hashes, doi: identifiers,
   * whatever the gatherer normalizes to. The oracle just checks set
   * membership against the resolved citation values.
   */
  readonly gatheredHashes: ReadonlySet<string>;
}

export interface UncitedClaim {
  readonly claim: string;
  readonly lineNumber: number;
}

export interface UnknownCitation {
  readonly claim: string;
  readonly lineNumber: number;
  /** The raw citation token (`'^id'` or `'hash:value'`) the writer used. */
  readonly token: string;
  /** The value the token resolved to, if a footnote definition existed. */
  readonly resolvedTo?: string;
  readonly reason: 'no-footnote-definition' | 'not-in-gathered-set';
}

export interface SourceCitationVerdict {
  readonly verified: boolean;
  readonly totalClaims: number;
  readonly citedClaims: number;
  readonly uncitedClaims: readonly UncitedClaim[];
  readonly unknownCitations: readonly UnknownCitation[];
  /**
   * Detected dominant format for trace clarity. `'none'` when no claims
   * were extracted (typically the synthesis output was empty or all
   * code blocks).
   */
  readonly format: 'markdown-footnote' | 'inline-hash' | 'mixed' | 'none';
}

/**
 * Verify that every claim in `synthesisText` cites a source the gather
 * step recorded. A claim is "verified" iff (a) it has ≥1 citation token
 * AND (b) every token resolves to a value in `gatheredHashes`.
 *
 * Empty input → `verified: true` with `totalClaims: 0`. The oracle does
 * NOT manufacture failures from absent claims — the protocol's
 * progression rules (preconditions) handle the "did the synthesis
 * step actually produce output?" question elsewhere.
 */
export function verifySourceCitations(input: SourceCitationInput): SourceCitationVerdict {
  const extracted = extractCitations(input.synthesisText);
  const uncitedClaims: UncitedClaim[] = [];
  const unknownCitations: UnknownCitation[] = [];
  let citedClaims = 0;

  for (const claim of extracted.claims) {
    if (claim.citations.length === 0) {
      uncitedClaims.push({ claim: claim.text, lineNumber: claim.lineNumber });
      continue;
    }

    let allResolved = true;
    for (const token of claim.citations) {
      const resolved = resolveCitation(token, extracted.footnotes);
      if (resolved === undefined) {
        unknownCitations.push({
          claim: claim.text,
          lineNumber: claim.lineNumber,
          token,
          reason: 'no-footnote-definition',
        });
        allResolved = false;
        continue;
      }
      if (!input.gatheredHashes.has(resolved)) {
        unknownCitations.push({
          claim: claim.text,
          lineNumber: claim.lineNumber,
          token,
          resolvedTo: resolved,
          reason: 'not-in-gathered-set',
        });
        allResolved = false;
      }
    }
    if (allResolved) citedClaims++;
  }

  return {
    verified: uncitedClaims.length === 0 && unknownCitations.length === 0,
    totalClaims: extracted.claims.length,
    citedClaims,
    uncitedClaims,
    unknownCitations,
    format: detectFormat(extracted.claims),
  };
}

function detectFormat(
  claims: ReadonlyArray<{ readonly citations: readonly string[] }>,
): SourceCitationVerdict['format'] {
  if (claims.length === 0) return 'none';
  let footnoteRefs = 0;
  let inlineRefs = 0;
  for (const c of claims) {
    for (const t of c.citations) {
      if (t.startsWith('^')) footnoteRefs++;
      else if (t.startsWith('hash:')) inlineRefs++;
    }
  }
  if (footnoteRefs === 0 && inlineRefs === 0) return 'none';
  if (footnoteRefs > 0 && inlineRefs > 0) return 'mixed';
  if (footnoteRefs > 0) return 'markdown-footnote';
  return 'inline-hash';
}
