/**
 * Tests for the citation extractor — Phase A2 source-citation oracle
 * pipeline. Behavior-only: every assertion exercises `extractCitations`
 * or `resolveCitation` and verifies the documented contract.
 *
 * Coverage:
 *   - markdown footnote refs + definitions roundtrip
 *   - inline `[hash:X]` extraction
 *   - mixed format (both in same body)
 *   - non-claim lines: headings, lists, blockquotes, blank lines
 *   - code fences ignored (don't fabricate uncited claims from sample code)
 *   - duplicate footnote definition: last wins
 *   - resolveCitation: footnote, inline-hash, unknown
 */
import { describe, expect, test } from 'bun:test';
import { extractCitations, resolveCitation } from '../../../src/oracle/role/source-citation/citation-extractor.ts';

describe('extractCitations — markdown footnote format', () => {
  test('captures one claim with one footnote ref + matching definition', () => {
    const text = `The sky is blue on Earth.[^a]\n\n[^a]: https://example.com/atmosphere`;
    const out = extractCitations(text);
    expect(out.claims).toHaveLength(1);
    expect(out.claims[0]?.text).toBe('The sky is blue on Earth.');
    expect(out.claims[0]?.citations).toEqual(['^a']);
    expect(out.footnotes.get('a')).toBe('https://example.com/atmosphere');
  });

  test('captures multiple distinct refs on one claim', () => {
    const text = `Water boils at 100°C at sea level.[^a][^b]\n\n[^a]: https://x\n[^b]: https://y`;
    const out = extractCitations(text);
    expect(out.claims[0]?.citations).toEqual(['^a', '^b']);
  });

  test('strips the citation marker from the human-readable claim text', () => {
    const text = `A claim sentence.[^k]`;
    const out = extractCitations(text);
    expect(out.claims[0]?.text).toBe('A claim sentence.');
  });

  test('claim with no citation is captured but with empty citations[]', () => {
    const text = 'A bald claim with no citation.';
    const out = extractCitations(text);
    expect(out.claims).toHaveLength(1);
    expect(out.claims[0]?.citations).toEqual([]);
  });

  test('duplicate footnote ids: last definition wins', () => {
    const text = `Claim.[^a]\n\n[^a]: first\n[^a]: second`;
    const out = extractCitations(text);
    expect(out.footnotes.get('a')).toBe('second');
  });
});

describe('extractCitations — inline hash format', () => {
  test('captures a single inline hash reference', () => {
    const text = 'A claim. [hash:abc123def]';
    const out = extractCitations(text);
    expect(out.claims[0]?.citations).toEqual(['hash:abc123def']);
    expect(out.inlineHashes.has('abc123def')).toBe(true);
  });

  test('captures multiple distinct inline hashes', () => {
    const text = 'A claim. [hash:a] [hash:b]';
    const out = extractCitations(text);
    expect(out.claims[0]?.citations).toEqual(['hash:a', 'hash:b']);
    expect(out.inlineHashes.has('a')).toBe(true);
    expect(out.inlineHashes.has('b')).toBe(true);
  });

  test('hash values may contain url-safe punctuation', () => {
    const text = 'Claim. [hash:sha256:abc=def-ghi.jkl]';
    const out = extractCitations(text);
    expect(out.claims[0]?.citations).toEqual(['hash:sha256:abc=def-ghi.jkl']);
  });
});

describe('extractCitations — mixed format', () => {
  test('claim line carries both footnote and inline-hash refs', () => {
    const text = `A mixed claim.[^a] [hash:abc]\n\n[^a]: url-a`;
    const out = extractCitations(text);
    expect(out.claims[0]?.citations).toEqual(['^a', 'hash:abc']);
    expect(out.footnotes.get('a')).toBe('url-a');
    expect(out.inlineHashes.has('abc')).toBe(true);
  });
});

describe('extractCitations — non-claim line filtering', () => {
  test('headings are not extracted as claims', () => {
    const text = `# Heading\n## Subheading\n\nReal claim.[^a]\n\n[^a]: url`;
    const out = extractCitations(text);
    expect(out.claims).toHaveLength(1);
    expect(out.claims[0]?.text).toBe('Real claim.');
  });

  test('list items are skipped (structural, not paragraph claim)', () => {
    const text = `- bullet item\n* asterisk item\n+ plus item\n1. numbered item\n\nReal claim.[^a]\n\n[^a]: url`;
    const out = extractCitations(text);
    expect(out.claims.map((c) => c.text)).toEqual(['Real claim.']);
  });

  test('blockquotes are skipped', () => {
    const text = `> quoted line\n\nReal claim.[^a]\n\n[^a]: url`;
    const out = extractCitations(text);
    expect(out.claims).toHaveLength(1);
  });

  test('blank lines are skipped', () => {
    const text = `\n\n  \n\nReal claim.[^a]\n\n[^a]: url`;
    const out = extractCitations(text);
    expect(out.claims).toHaveLength(1);
  });

  test('code fences strip their contents (no fabricated claims from sample code)', () => {
    const text = [
      'Real claim.[^a]',
      '',
      '```typescript',
      'const x = "this looks like a claim but is not";',
      'foo[^b](); // fake footnote ref inside code',
      '```',
      '',
      '[^a]: url',
    ].join('\n');
    const out = extractCitations(text);
    expect(out.claims.map((c) => c.text)).toEqual(['Real claim.']);
    // Footnote def OUTSIDE the fence still registered:
    expect(out.footnotes.get('a')).toBe('url');
    // Footnote ref INSIDE the fence not extracted as a citation:
    expect(out.claims[0]?.citations).toEqual(['^a']);
  });
});

describe('extractCitations — line numbering', () => {
  test('lineNumber is 1-indexed and reflects the claim line in the source', () => {
    const text = `# Heading\n\nFirst claim.[^a]\nSecond claim.[^b]\n\n[^a]: u\n[^b]: v`;
    const out = extractCitations(text);
    expect(out.claims).toHaveLength(2);
    expect(out.claims[0]?.lineNumber).toBe(3);
    expect(out.claims[1]?.lineNumber).toBe(4);
  });
});

describe('extractCitations — empty / edge inputs', () => {
  test('empty string returns no claims', () => {
    expect(extractCitations('').claims).toEqual([]);
  });

  test('text containing only fenced code returns no claims', () => {
    const text = '```\nconst x = 1;\n```';
    expect(extractCitations(text).claims).toEqual([]);
  });

  test('text with unmatched footnote refs (no definition) still extracts the citation token', () => {
    const text = 'Claim.[^orphan]';
    const out = extractCitations(text);
    expect(out.claims[0]?.citations).toEqual(['^orphan']);
    expect(out.footnotes.has('orphan')).toBe(false);
  });
});

describe('resolveCitation', () => {
  test('inline hash token returns the value', () => {
    expect(resolveCitation('hash:abc', new Map())).toBe('abc');
  });

  test('footnote token resolves via the footnotes map', () => {
    const fn = new Map([['a', 'https://example.com']]);
    expect(resolveCitation('^a', fn)).toBe('https://example.com');
  });

  test('footnote token without a matching definition returns undefined', () => {
    expect(resolveCitation('^orphan', new Map())).toBeUndefined();
  });

  test('non-conforming token returns undefined', () => {
    expect(resolveCitation('garbage-token', new Map())).toBeUndefined();
  });
});
