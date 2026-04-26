/**
 * Compaction summary verifier tests — G7 A1 enforcement.
 */
import { describe, expect, test } from 'bun:test';
import { extractClaims, verifyCompactionSummary } from '../../../src/orchestrator/agent/compaction-summary-verifier.ts';

describe('extractClaims', () => {
  test('returns no claims for plain prose', () => {
    expect(extractClaims('The agent did some work.')).toEqual([]);
  });

  test('matches relative file paths with extensions', () => {
    const claims = extractClaims('Edited src/auth/login.ts and src/db/user.ts');
    expect(claims.map((c) => c.text)).toEqual(['src/auth/login.ts', 'src/db/user.ts']);
    expect(claims.every((c) => c.kind === 'file-path')).toBe(true);
  });

  test('does not match bare extensions in prose', () => {
    const claims = extractClaims('Fixed the .ts errors and tightened .json config.');
    expect(claims).toEqual([]);
  });

  test('collapses duplicate claims (first occurrence wins)', () => {
    const claims = extractClaims('Touched src/foo.ts. Then src/foo.ts again. And src/bar.ts.');
    expect(claims.map((c) => c.text)).toEqual(['src/foo.ts', 'src/bar.ts']);
  });

  test('matches dotted symbols like Class.method', () => {
    const claims = extractClaims('Refactored AuthService.login and ConfigStore.read');
    const symbols = claims.filter((c) => c.kind === 'symbol').map((c) => c.text);
    expect(symbols).toContain('AuthService.login');
    expect(symbols).toContain('ConfigStore.read');
  });

  test('does not double-count a token already matched as a file path', () => {
    const claims = extractClaims('See src/auth/login.ts');
    const texts = claims.map((c) => c.text);
    // The path itself should appear once; no symbol-classification of substrings.
    expect(texts.filter((t) => t === 'src/auth/login.ts')).toHaveLength(1);
  });

  test('records left-to-right scan order with offsets', () => {
    const summary = 'wrote src/a.ts then src/b.ts';
    const claims = extractClaims(summary);
    expect(claims).toHaveLength(2);
    expect(claims[0]?.text).toBe('src/a.ts');
    expect(claims[1]?.text).toBe('src/b.ts');
    expect(claims[0]!.offset).toBeLessThan(claims[1]!.offset);
  });
});

describe('verifyCompactionSummary', () => {
  test('vacuously passes when summary has no claims', () => {
    const result = verifyCompactionSummary('Compacted 12 narrative turns. Nothing to verify.', {
      factLookup: () => false, // would fail every claim, but there are none
    });
    expect(result.verified).toBe(true);
    expect(result.orphanRatio).toBe(0);
    expect(result.claims).toEqual([]);
    expect(result.orphans).toEqual([]);
  });

  test('passes when all claims are recognized by the fact source', () => {
    const known = new Set(['src/a.ts', 'src/b.ts']);
    const result = verifyCompactionSummary('Touched src/a.ts and src/b.ts.', {
      factLookup: (c) => known.has(c),
    });
    expect(result.verified).toBe(true);
    expect(result.orphanRatio).toBe(0);
    expect(result.orphans).toEqual([]);
  });

  test('fails when orphan ratio exceeds threshold', () => {
    const known = new Set(['src/a.ts']);
    // 1 orphan out of 2 claims → 0.5 ratio, default threshold 0.10
    const result = verifyCompactionSummary('Touched src/a.ts and fabricated src/ghost.ts.', {
      factLookup: (c) => known.has(c),
    });
    expect(result.verified).toBe(false);
    expect(result.orphanRatio).toBe(0.5);
    expect(result.orphans.map((o) => o.text)).toEqual(['src/ghost.ts']);
  });

  test('respects caller-provided maxOrphanRatio', () => {
    const known = new Set(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    // 1 orphan out of 4 claims → 0.25 ratio
    const summary = 'Touched src/a.ts, src/b.ts, src/c.ts, fabricated src/ghost.ts.';
    const strict = verifyCompactionSummary(summary, { factLookup: (c) => known.has(c), maxOrphanRatio: 0.1 });
    expect(strict.verified).toBe(false);
    const lenient = verifyCompactionSummary(summary, { factLookup: (c) => known.has(c), maxOrphanRatio: 0.3 });
    expect(lenient.verified).toBe(true);
  });

  test('treats factLookup exceptions as orphan (defensive)', () => {
    const result = verifyCompactionSummary('Touched src/a.ts and src/b.ts.', {
      factLookup: (c) => {
        if (c === 'src/b.ts') throw new Error('world-graph offline');
        return c === 'src/a.ts';
      },
    });
    expect(result.orphans.map((o) => o.text)).toEqual(['src/b.ts']);
    expect(result.orphanRatio).toBe(0.5);
  });

  test('reports threshold used in the result for downstream tracing', () => {
    const result = verifyCompactionSummary('No claims here.', {
      factLookup: () => true,
      maxOrphanRatio: 0.25,
    });
    expect(result.threshold).toBe(0.25);
  });

  test('symbol claims also count toward orphan detection', () => {
    const known = new Set<string>(); // nothing recognized
    const result = verifyCompactionSummary('Refactored AuthService.login.', {
      factLookup: (c) => known.has(c),
    });
    expect(result.orphans.some((o) => o.text === 'AuthService.login')).toBe(true);
    expect(result.verified).toBe(false);
  });
});
