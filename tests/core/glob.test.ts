import { describe, expect, test } from 'bun:test';
import { simpleGlobMatch } from '../../src/core/glob.ts';

describe('simpleGlobMatch', () => {
  test('* matches any sequence', () => {
    expect(simpleGlobMatch('*.ts', 'foo.ts')).toBe(true);
    expect(simpleGlobMatch('*.ts', 'foo.js')).toBe(false);
    expect(simpleGlobMatch('src/*.ts', 'src/foo.ts')).toBe(true);
    expect(simpleGlobMatch('src/*', 'src/foo.ts')).toBe(true);
  });

  test('exact match without wildcards', () => {
    expect(simpleGlobMatch('exact', 'exact')).toBe(true);
    expect(simpleGlobMatch('exact', 'other')).toBe(false);
  });

  test('dots are escaped (not regex any-char)', () => {
    expect(simpleGlobMatch('foo.ts', 'foo.ts')).toBe(true);
    expect(simpleGlobMatch('foo.ts', 'fooxts')).toBe(false);
  });

  test('+ is escaped (not regex one-or-more)', () => {
    expect(simpleGlobMatch('foo+bar', 'foo+bar')).toBe(true);
    expect(simpleGlobMatch('foo+bar', 'foobar')).toBe(false);
    expect(simpleGlobMatch('foo+bar', 'fooobar')).toBe(false);
  });

  test('? is escaped (not regex optional)', () => {
    expect(simpleGlobMatch('foo?bar', 'foo?bar')).toBe(true);
    expect(simpleGlobMatch('foo?bar', 'foobar')).toBe(false);
  });

  test('() are escaped (not regex grouping)', () => {
    expect(simpleGlobMatch('(test)', '(test)')).toBe(true);
    expect(simpleGlobMatch('(test)', 'test')).toBe(false);
  });

  test('[] are escaped (not regex character class)', () => {
    expect(simpleGlobMatch('[test]', '[test]')).toBe(true);
    expect(simpleGlobMatch('[test]', 't')).toBe(false);
  });

  test('{} are escaped (not regex quantifier)', () => {
    expect(simpleGlobMatch('a{2}', 'a{2}')).toBe(true);
    expect(simpleGlobMatch('a{2}', 'aa')).toBe(false);
  });

  test('| is escaped (not regex alternation)', () => {
    expect(simpleGlobMatch('a|b', 'a|b')).toBe(true);
    expect(simpleGlobMatch('a|b', 'a')).toBe(false);
  });

  test('^ and $ are escaped', () => {
    expect(simpleGlobMatch('^start', '^start')).toBe(true);
    expect(simpleGlobMatch('end$', 'end$')).toBe(true);
  });

  test('multiple wildcards', () => {
    expect(simpleGlobMatch('src/*/index.*', 'src/core/index.ts')).toBe(true);
    expect(simpleGlobMatch('src/*/index.*', 'src/core/index.js')).toBe(true);
    expect(simpleGlobMatch('src/*/index.*', 'lib/core/index.ts')).toBe(false);
  });
});
