/**
 * Tests for the skill-tag matcher (Phase-5B).
 *
 * Covers:
 *   - exact match
 *   - single-segment wildcard (`language:*` matches `language:typescript`)
 *   - segment-count mismatch (multi-segment skill tag does NOT match
 *     single-segment wildcard)
 *   - empty persona / skill tags reject
 *   - any-of-any acceptance (any persona pattern matches any skill tag)
 */
import { describe, expect, test } from 'bun:test';
import { matchesAcquirableTags, matchOne } from '../../../src/orchestrator/agents/skill-tag-matcher.ts';

describe('matchOne', () => {
  test('exact match wins', () => {
    expect(matchOne('language:typescript', 'language:typescript')).toBe(true);
  });

  test('single-segment wildcard matches', () => {
    expect(matchOne('language:*', 'language:typescript')).toBe(true);
    expect(matchOne('framework:*', 'framework:react')).toBe(true);
  });

  test('wildcard does not match across segments', () => {
    // pattern has 2 segments, tag has 3 → reject
    expect(matchOne('language:*', 'language:typescript:strict')).toBe(false);
  });

  test('different prefix → no match even with wildcard', () => {
    expect(matchOne('language:*', 'framework:react')).toBe(false);
  });

  test('no wildcard, different value → no match', () => {
    expect(matchOne('language:typescript', 'language:python')).toBe(false);
  });

  test('exact wildcard tag', () => {
    expect(matchOne('*', 'singleton')).toBe(true);
  });
});

describe('matchesAcquirableTags', () => {
  test('any persona pattern matches any skill tag', () => {
    expect(matchesAcquirableTags(['language:*', 'framework:*'], ['language:typescript'])).toBe(true);
    expect(matchesAcquirableTags(['language:*'], ['framework:react', 'language:typescript'])).toBe(true);
  });

  test('no overlap → reject', () => {
    expect(matchesAcquirableTags(['language:*'], ['framework:react'])).toBe(false);
  });

  test('empty persona tags → reject (no scope declared)', () => {
    expect(matchesAcquirableTags([], ['language:typescript'])).toBe(false);
    expect(matchesAcquirableTags(undefined, ['language:typescript'])).toBe(false);
  });

  test('empty skill tags → reject (no scope claim)', () => {
    expect(matchesAcquirableTags(['language:*'], [])).toBe(false);
    expect(matchesAcquirableTags(['language:*'], undefined)).toBe(false);
  });

  test('exact and wildcard coexist', () => {
    expect(matchesAcquirableTags(['review:code', 'review:*'], ['review:prose'])).toBe(true);
    expect(matchesAcquirableTags(['review:code'], ['review:prose'])).toBe(false);
  });
});
