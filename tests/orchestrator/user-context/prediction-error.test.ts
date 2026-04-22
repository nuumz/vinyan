/**
 * Tests for USER.md prediction-error metric (Jaccard distance MVP).
 *
 * We pin the four properties the dialectic rule relies on:
 *   - Range in [0, 1].
 *   - Symmetric: delta(a, b) === delta(b, a).
 *   - Identity: delta(x, x) === 0 for non-empty x.
 *   - Monotonic on overlap: more shared tokens → lower distance.
 */
import { describe, expect, test } from 'bun:test';

import { computeSectionDelta, rollingMean } from '../../../src/orchestrator/user-context/prediction-error.ts';

describe('computeSectionDelta (Jaccard)', () => {
  test('returns 0 for identical non-empty strings', () => {
    expect(computeSectionDelta('user prefers terse replies', 'user prefers terse replies')).toBe(0);
  });

  test('is bounded in [0, 1]', () => {
    const pairs: Array<[string, string]> = [
      ['', ''],
      ['a', 'a'],
      ['a b c', 'd e f'],
      ['totally distinct here', 'nothing overlaps at all'],
      ['some shared words and others', 'shared words totally different otherwise'],
    ];
    for (const [a, b] of pairs) {
      const d = computeSectionDelta(a, b);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(1);
    }
  });

  test('is symmetric', () => {
    const a = 'prefers typescript strict mode with bun';
    const b = 'user uses javascript and npm instead of bun';
    expect(computeSectionDelta(a, b)).toBeCloseTo(computeSectionDelta(b, a));
  });

  test('empty-vs-empty is 0; empty-vs-nonempty is 1', () => {
    expect(computeSectionDelta('', '')).toBe(0);
    expect(computeSectionDelta('', 'something')).toBe(1);
    expect(computeSectionDelta('something', '')).toBe(1);
  });

  test('returns 1 for fully disjoint token sets', () => {
    expect(computeSectionDelta('alpha beta gamma', 'delta epsilon zeta')).toBe(1);
  });

  test('is monotonic on token overlap', () => {
    // As `observed` shares more tokens with `predicted`, distance should decrease.
    const predicted = 'user prefers terse replies without preamble';
    const observedNone = 'completely different response entirely';
    const observedSome = 'replies are acceptable occasionally';
    const observedMore = 'terse replies without preamble sometimes';

    const dNone = computeSectionDelta(predicted, observedNone);
    const dSome = computeSectionDelta(predicted, observedSome);
    const dMore = computeSectionDelta(predicted, observedMore);

    expect(dNone).toBeGreaterThan(dSome);
    expect(dSome).toBeGreaterThan(dMore);
    expect(dMore).toBeGreaterThan(0);
  });
});

describe('rollingMean', () => {
  test('returns 0 on empty input', () => {
    expect(rollingMean([])).toBe(0);
  });

  test('averages deltas evenly', () => {
    expect(rollingMean([0, 1])).toBeCloseTo(0.5);
    expect(rollingMean([0.2, 0.4, 0.6])).toBeCloseTo(0.4);
    expect(rollingMean([1, 1, 1, 1])).toBe(1);
  });
});
