/**
 * Tests for `verifySourceCitations` — Phase A2 source-citation oracle.
 *
 * Behavior-only: every assertion exercises the oracle and verifies the
 * documented contract of `SourceCitationVerdict`.
 *
 * Coverage:
 *   - verified=true happy path: every claim cited + every citation resolves into gatheredHashes
 *   - verified=false: at least one uncited claim
 *   - verified=false: citation resolves to a value NOT in gatheredHashes
 *   - verified=false: citation references a footnote with no definition
 *   - empty input: verified=true (vacuous), totalClaims=0
 *   - format detection: markdown-footnote / inline-hash / mixed / none
 *   - structured diagnostics surface line numbers + tokens for audit
 */
import { describe, expect, test } from 'bun:test';
import { verifySourceCitations } from '../../../src/oracle/role/source-citation/index.ts';

describe('verifySourceCitations — happy path', () => {
  test('all claims cited, all citations resolve to gathered hashes → verified', () => {
    const text = `First claim.[^a]\nSecond claim. [hash:bbb]\n\n[^a]: aaa`;
    const verdict = verifySourceCitations({
      synthesisText: text,
      gatheredHashes: new Set(['aaa', 'bbb']),
    });
    expect(verdict.verified).toBe(true);
    expect(verdict.totalClaims).toBe(2);
    expect(verdict.citedClaims).toBe(2);
    expect(verdict.uncitedClaims).toEqual([]);
    expect(verdict.unknownCitations).toEqual([]);
  });

  test('format=mixed when both footnote and inline-hash present', () => {
    const text = `Claim.[^a] [hash:bbb]\n\n[^a]: aaa`;
    expect(
      verifySourceCitations({
        synthesisText: text,
        gatheredHashes: new Set(['aaa', 'bbb']),
      }).format,
    ).toBe('mixed');
  });

  test('format=markdown-footnote when only [^id] used', () => {
    const text = `Claim.[^a]\n\n[^a]: aaa`;
    expect(verifySourceCitations({ synthesisText: text, gatheredHashes: new Set(['aaa']) }).format).toBe(
      'markdown-footnote',
    );
  });

  test('format=inline-hash when only [hash:X] used', () => {
    const text = `Claim. [hash:abc]`;
    expect(verifySourceCitations({ synthesisText: text, gatheredHashes: new Set(['abc']) }).format).toBe('inline-hash');
  });
});

describe('verifySourceCitations — failures', () => {
  test('uncited claim → verified=false; uncitedClaims surfaces the line', () => {
    const text = `A bald claim.\nA cited one.[^a]\n\n[^a]: aaa`;
    const verdict = verifySourceCitations({
      synthesisText: text,
      gatheredHashes: new Set(['aaa']),
    });
    expect(verdict.verified).toBe(false);
    expect(verdict.uncitedClaims).toHaveLength(1);
    expect(verdict.uncitedClaims[0]?.claim).toBe('A bald claim.');
    expect(verdict.uncitedClaims[0]?.lineNumber).toBe(1);
    expect(verdict.totalClaims).toBe(2);
    expect(verdict.citedClaims).toBe(1);
  });

  test('citation resolves to value NOT in gatheredHashes → unknownCitations', () => {
    const text = `Claim.[^a]\n\n[^a]: not-gathered-yet`;
    const verdict = verifySourceCitations({
      synthesisText: text,
      gatheredHashes: new Set(['something-else']),
    });
    expect(verdict.verified).toBe(false);
    expect(verdict.unknownCitations).toHaveLength(1);
    expect(verdict.unknownCitations[0]?.token).toBe('^a');
    expect(verdict.unknownCitations[0]?.resolvedTo).toBe('not-gathered-yet');
    expect(verdict.unknownCitations[0]?.reason).toBe('not-in-gathered-set');
  });

  test('orphan footnote ref (no definition) → reason=no-footnote-definition', () => {
    const text = `Claim.[^orphan]`;
    const verdict = verifySourceCitations({
      synthesisText: text,
      gatheredHashes: new Set(['aaa']),
    });
    expect(verdict.verified).toBe(false);
    expect(verdict.unknownCitations[0]?.reason).toBe('no-footnote-definition');
    expect(verdict.unknownCitations[0]?.resolvedTo).toBeUndefined();
  });

  test('inline hash NOT in gatheredHashes → not-in-gathered-set', () => {
    const text = `Claim. [hash:rogue]`;
    const verdict = verifySourceCitations({
      synthesisText: text,
      gatheredHashes: new Set(['real']),
    });
    expect(verdict.verified).toBe(false);
    expect(verdict.unknownCitations[0]?.token).toBe('hash:rogue');
    expect(verdict.unknownCitations[0]?.resolvedTo).toBe('rogue');
    expect(verdict.unknownCitations[0]?.reason).toBe('not-in-gathered-set');
  });

  test('mixed failure: one uncited + one unknown citation in same body', () => {
    const text = `Bald.\nClaim.[^missing]`;
    const verdict = verifySourceCitations({
      synthesisText: text,
      gatheredHashes: new Set(['aaa']),
    });
    expect(verdict.verified).toBe(false);
    expect(verdict.uncitedClaims).toHaveLength(1);
    expect(verdict.unknownCitations).toHaveLength(1);
    expect(verdict.totalClaims).toBe(2);
    expect(verdict.citedClaims).toBe(0);
  });
});

describe('verifySourceCitations — edge cases', () => {
  test('empty input → verified=true, totalClaims=0, format=none', () => {
    const verdict = verifySourceCitations({
      synthesisText: '',
      gatheredHashes: new Set(),
    });
    expect(verdict.verified).toBe(true);
    expect(verdict.totalClaims).toBe(0);
    expect(verdict.format).toBe('none');
  });

  test('text containing only headings → no claims, vacuous pass', () => {
    const verdict = verifySourceCitations({
      synthesisText: '# Heading\n## Sub',
      gatheredHashes: new Set(),
    });
    expect(verdict.verified).toBe(true);
    expect(verdict.totalClaims).toBe(0);
  });

  test('claim with multiple citations, ALL must resolve for the claim to be cited', () => {
    const text = `Claim.[^a][^b]\n\n[^a]: aaa\n[^b]: bbb`;
    const verdictBothGood = verifySourceCitations({
      synthesisText: text,
      gatheredHashes: new Set(['aaa', 'bbb']),
    });
    expect(verdictBothGood.verified).toBe(true);
    expect(verdictBothGood.citedClaims).toBe(1);

    const verdictOneBad = verifySourceCitations({
      synthesisText: text,
      gatheredHashes: new Set(['aaa']), // bbb missing
    });
    expect(verdictOneBad.verified).toBe(false);
    expect(verdictOneBad.citedClaims).toBe(0);
    expect(verdictOneBad.unknownCitations).toHaveLength(1);
    expect(verdictOneBad.unknownCitations[0]?.token).toBe('^b');
  });

  test('determinism: same input produces same verdict (A8 replay)', () => {
    const text = `Claim 1.[^a]\nClaim 2.[^b]\nUncited claim.\n\n[^a]: aaa\n[^b]: bbb`;
    const input = { synthesisText: text, gatheredHashes: new Set(['aaa', 'bbb']) };
    const v1 = verifySourceCitations(input);
    const v2 = verifySourceCitations(input);
    expect(v1).toEqual(v2);
  });
});
