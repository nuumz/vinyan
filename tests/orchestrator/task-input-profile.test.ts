/**
 * TaskInput profile coercion + validation — W1 PR #1 consumer wiring.
 *
 * Verifies the invariant at the `executeTask` entry point: `profile` is
 * intermediate-optional, defaulted to `'default'`, and rejects malformed
 * names synchronously.
 */

import { describe, expect, test } from 'bun:test';
import { coerceProfile, isValidProfileName, PROFILE_REGEX, type TaskInput } from '../../src/orchestrator/types.ts';

describe('coerceProfile', () => {
  test("undefined → 'default'", () => {
    expect(coerceProfile(undefined)).toBe('default');
  });

  test("literal 'default' passes through", () => {
    expect(coerceProfile('default')).toBe('default');
  });

  test('valid kebab-case names pass through', () => {
    expect(coerceProfile('work')).toBe('work');
    expect(coerceProfile('multi-word')).toBe('multi-word');
    expect(coerceProfile('a1-b2')).toBe('a1-b2');
  });

  test('rejects empty string', () => {
    expect(() => coerceProfile('')).toThrow(/invalid profile name/);
  });

  test('rejects uppercase letters', () => {
    expect(() => coerceProfile('WORK')).toThrow(/invalid profile name/);
    expect(() => coerceProfile('Work')).toThrow(/invalid profile name/);
    expect(() => coerceProfile('wORK')).toThrow(/invalid profile name/);
  });

  test('rejects path-traversal characters', () => {
    expect(() => coerceProfile('../etc')).toThrow(/invalid profile name/);
    expect(() => coerceProfile('a/b')).toThrow(/invalid profile name/);
    expect(() => coerceProfile('a\\b')).toThrow(/invalid profile name/);
  });

  test('rejects leading digit', () => {
    expect(() => coerceProfile('1work')).toThrow(/invalid profile name/);
  });

  test('rejects leading dash', () => {
    expect(() => coerceProfile('-work')).toThrow(/invalid profile name/);
  });

  test('rejects whitespace / special chars', () => {
    expect(() => coerceProfile('my profile')).toThrow(/invalid profile name/);
    expect(() => coerceProfile('my_profile')).toThrow(/invalid profile name/);
    expect(() => coerceProfile('my.profile')).toThrow(/invalid profile name/);
  });
});

describe('isValidProfileName', () => {
  test("returns true for 'default'", () => {
    expect(isValidProfileName('default')).toBe(true);
  });

  test('returns true for kebab-case', () => {
    expect(isValidProfileName('work')).toBe(true);
    expect(isValidProfileName('multi-word')).toBe(true);
  });

  test('returns false for non-string input', () => {
    expect(isValidProfileName(undefined)).toBe(false);
    expect(isValidProfileName(null)).toBe(false);
    expect(isValidProfileName(123)).toBe(false);
    expect(isValidProfileName({})).toBe(false);
  });

  test('returns false for invalid strings', () => {
    expect(isValidProfileName('')).toBe(false);
    expect(isValidProfileName('WORK')).toBe(false);
    expect(isValidProfileName('../etc')).toBe(false);
  });
});

describe('PROFILE_REGEX', () => {
  test('mirrors the documented pattern', () => {
    expect(PROFILE_REGEX.test('work')).toBe(true);
    expect(PROFILE_REGEX.test('multi-word')).toBe(true);
    expect(PROFILE_REGEX.test('WORK')).toBe(false);
    expect(PROFILE_REGEX.test('1work')).toBe(false);
  });
});

describe('TaskInput shape — profile field is optional', () => {
  test('TaskInput without profile compiles (backwards compat)', () => {
    // Purely a type-shape assertion — if the field accidentally becomes
    // required, this file stops type-checking.
    const input: TaskInput = {
      id: 't1',
      source: 'cli',
      goal: 'test goal',
      taskType: 'reasoning',
      budget: { maxTokens: 1000, maxDurationMs: 1000, maxRetries: 0 },
    };
    expect(input.profile).toBeUndefined();
    expect(coerceProfile(input.profile)).toBe('default');
  });

  test('TaskInput accepts optional profile', () => {
    const input: TaskInput = {
      id: 't2',
      source: 'cli',
      goal: 'test goal',
      taskType: 'reasoning',
      profile: 'work',
      budget: { maxTokens: 1000, maxDurationMs: 1000, maxRetries: 0 },
    };
    expect(input.profile).toBe('work');
  });
});
