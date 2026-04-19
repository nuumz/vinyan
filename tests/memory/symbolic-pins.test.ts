/**
 * Symbolic pin extraction (plan commit E).
 */
import { describe, expect, it } from 'bun:test';
import { extractPins } from '../../src/memory/symbolic-pins.ts';

describe('extractPins', () => {
  it('returns empty array for empty message', () => {
    expect(extractPins('')).toEqual([]);
  });

  it('returns empty array for message with no pins', () => {
    expect(extractPins('just plain text, no references')).toEqual([]);
  });

  it('extracts @file:path explicit prefix', () => {
    const pins = extractPins('please review @file:src/auth.ts and merge');
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ kind: 'file', value: 'src/auth.ts' });
  });

  it('extracts @turn:id explicit prefix', () => {
    const pins = extractPins('reference @turn:abc123 for context');
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ kind: 'turn', value: 'abc123' });
  });

  it('extracts #task-id', () => {
    const pins = extractPins('part of #task-42 rollout');
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ kind: 'task', value: 'task-42' });
  });

  it('extracts bare @path with slash', () => {
    const pins = extractPins('look at @src/foo.ts please');
    expect(pins.length).toBeGreaterThan(0);
    const file = pins.find((p) => p.kind === 'file' && p.value.includes('src/foo.ts'));
    expect(file).toBeDefined();
  });

  it('extracts bare @path with extension', () => {
    const pins = extractPins('also @README.md');
    const file = pins.find((p) => p.kind === 'file' && p.value === 'README.md');
    expect(file).toBeDefined();
  });

  it('does not false-match bare @word without slash or extension', () => {
    const pins = extractPins('@everyone please review');
    const file = pins.find((p) => p.kind === 'file' && p.value === 'everyone');
    expect(file).toBeUndefined();
  });

  it('does not false-match #1 (too short)', () => {
    const pins = extractPins('issue #1 and #42-fix');
    // #1 rejected (min 3 chars), #42-fix kept
    expect(pins.some((p) => p.kind === 'task' && p.value === '1')).toBe(false);
    expect(pins.some((p) => p.kind === 'task' && p.value === '42-fix')).toBe(true);
  });

  it('deduplicates same (kind, value) pair', () => {
    const pins = extractPins('@file:src/a.ts and later @file:src/a.ts');
    const files = pins.filter((p) => p.kind === 'file' && p.value === 'src/a.ts');
    expect(files).toHaveLength(1);
  });

  it('preserves appearance order across pin types', () => {
    const pins = extractPins('first @file:a.ts then #task-b then @turn:c');
    expect(pins.map((p) => p.kind)).toEqual(['file', 'task', 'turn']);
    expect(pins.map((p) => p.value)).toEqual(['a.ts', 'task-b', 'c']);
  });

  it('captures start/end offsets for UI highlighting', () => {
    const message = 'see @file:foo.ts now';
    const pins = extractPins(message);
    expect(pins[0]!.start).toBe(4);
    expect(pins[0]!.end).toBe(4 + '@file:foo.ts'.length);
  });

  it('handles multiple pins of the same kind', () => {
    const pins = extractPins('#task-a #task-b #task-c');
    const tasks = pins.filter((p) => p.kind === 'task');
    expect(tasks.map((p) => p.value)).toEqual(['task-a', 'task-b', 'task-c']);
  });
});
