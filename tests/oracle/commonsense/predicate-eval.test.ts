import { describe, expect, test } from 'bun:test';
import { evaluatePattern } from '../../../src/oracle/commonsense/predicate-eval.ts';
import type { Pattern } from '../../../src/oracle/commonsense/types.ts';

describe('evaluatePattern — literal-substring', () => {
  test('matches when needle is in haystack (case-sensitive default)', () => {
    const pattern: Pattern = {
      kind: 'literal-substring',
      target_field: 'command',
      needle: 'rm -rf',
      case_sensitive: true,
    };
    expect(evaluatePattern(pattern, { command: 'sudo rm -rf /tmp' })).toBe(true);
    expect(evaluatePattern(pattern, { command: 'echo hello' })).toBe(false);
  });

  test('case-insensitive when case_sensitive=false', () => {
    const pattern: Pattern = {
      kind: 'literal-substring',
      target_field: 'command',
      needle: 'DROP TABLE',
      case_sensitive: false,
    };
    expect(evaluatePattern(pattern, { command: 'drop table users' })).toBe(true);
    expect(evaluatePattern(pattern, { command: 'DROP TABLE users' })).toBe(true);
    expect(evaluatePattern(pattern, { command: 'select * from t' })).toBe(false);
  });

  test('returns false when target_field is missing from context', () => {
    const pattern: Pattern = {
      kind: 'literal-substring',
      target_field: 'path',
      needle: 'tests',
      case_sensitive: true,
    };
    expect(evaluatePattern(pattern, { command: 'rm tests/' })).toBe(false);
  });
});

describe('evaluatePattern — exact-match', () => {
  test('matches only on full equality', () => {
    const pattern: Pattern = {
      kind: 'exact-match',
      target_field: 'verb',
      value: 'add',
    };
    expect(evaluatePattern(pattern, { verb: 'add' })).toBe(true);
    expect(evaluatePattern(pattern, { verb: 'added' })).toBe(false);
    expect(evaluatePattern(pattern, { verb: 'addition' })).toBe(false);
  });
});

describe('evaluatePattern — regex', () => {
  test('respects regex flags', () => {
    const pattern: Pattern = {
      kind: 'regex',
      target_field: 'command',
      pattern: '\\bDROP\\s+TABLE\\b',
      flags: 'i',
    };
    expect(evaluatePattern(pattern, { command: 'drop table foo' })).toBe(true);
    expect(evaluatePattern(pattern, { command: 'DROPS TABLE foo' })).toBe(false);
  });

  test('malformed regex returns false rather than throwing', () => {
    const pattern: Pattern = {
      kind: 'regex',
      target_field: 'command',
      pattern: '[unclosed',
    };
    expect(evaluatePattern(pattern, { command: 'anything' })).toBe(false);
  });
});
