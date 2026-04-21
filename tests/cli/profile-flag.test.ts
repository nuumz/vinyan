/**
 * CLI profile flag parsing — W1 PR #1 consumer wiring.
 *
 * Unit-tests `extractProfileFlag`, the tiny argv scanner exported from
 * `src/cli/index.ts`. End-to-end tests that spawn the CLI subprocess
 * live alongside `tests/cli/run.test.ts`; this file keeps the parser
 * fast and deterministic by invoking the function directly.
 */

import { describe, expect, test } from 'bun:test';
import { extractProfileFlag } from '../../src/cli/index.ts';
import { coerceProfile } from '../../src/orchestrator/types.ts';

describe('extractProfileFlag', () => {
  test('long form: --profile work', () => {
    expect(extractProfileFlag(['run', '--profile', 'work', 'goal'])).toBe('work');
  });

  test('short form: -p work', () => {
    expect(extractProfileFlag(['chat', '-p', 'work'])).toBe('work');
  });

  test('equals form: --profile=work', () => {
    expect(extractProfileFlag(['run', '--profile=work', 'goal'])).toBe('work');
  });

  test('missing flag returns undefined', () => {
    expect(extractProfileFlag(['run', 'goal', '--verbose'])).toBeUndefined();
  });

  test('empty argv returns undefined', () => {
    expect(extractProfileFlag([])).toBeUndefined();
  });

  test('-p with no following value throws', () => {
    expect(() => extractProfileFlag(['run', '-p'])).toThrow(/requires a profile name/);
  });

  test('--profile followed by another flag throws (does not silently consume --verbose)', () => {
    expect(() => extractProfileFlag(['run', '--profile', '--verbose'])).toThrow(/requires a profile name/);
  });

  test('--profile= (empty value) throws', () => {
    expect(() => extractProfileFlag(['run', '--profile='])).toThrow(/requires a profile name/);
  });

  test('first occurrence wins when flag is repeated', () => {
    expect(extractProfileFlag(['run', '-p', 'first', '--profile', 'second'])).toBe('first');
  });
});

describe('coerceProfile downstream validation', () => {
  // The flag parser itself is transport-level; downstream it gets run
  // through `coerceProfile`, so name-shape rejection happens there.
  test('rejects uppercase', () => {
    expect(() => coerceProfile('WORK')).toThrow(/invalid profile name/);
  });

  test('rejects path separators', () => {
    expect(() => coerceProfile('../etc')).toThrow(/invalid profile name/);
  });

  test('rejects leading dash / empty', () => {
    expect(() => coerceProfile('')).toThrow(/invalid profile name/);
    expect(() => coerceProfile('-work')).toThrow(/invalid profile name/);
  });

  test('accepts kebab-case', () => {
    expect(coerceProfile('work')).toBe('work');
    expect(coerceProfile('multi-word')).toBe('multi-word');
    expect(coerceProfile('a1')).toBe('a1');
  });

  test("accepts literal 'default'", () => {
    expect(coerceProfile('default')).toBe('default');
  });
});
