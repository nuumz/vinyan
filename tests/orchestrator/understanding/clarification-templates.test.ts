/**
 * Tests for clarification-templates — template library + domain inference.
 */
import { describe, expect, test } from 'bun:test';
import { liftStringsToStructured } from '../../../src/core/clarification.ts';
import {
  buildClarificationSet,
  buildGenreQuestion,
  inferCreativeDomain,
} from '../../../src/orchestrator/understanding/clarification-templates.ts';

describe('inferCreativeDomain', () => {
  test('identifies webtoon domain', () => {
    expect(inferCreativeDomain('เขียนเว็บตูนแนวโรแมนซ์')).toBe('webtoon');
    expect(inferCreativeDomain('write a webtoon romance')).toBe('webtoon');
  });

  test('identifies novel domain', () => {
    expect(inferCreativeDomain('อยากเขียนนิยาย')).toBe('novel');
    expect(inferCreativeDomain('write a short story')).toBe('novel');
  });

  test('identifies article domain', () => {
    expect(inferCreativeDomain('เขียนบทความ tech')).toBe('article');
    expect(inferCreativeDomain('draft a blog post')).toBe('article');
  });

  test('identifies video domain', () => {
    expect(inferCreativeDomain('อยากทำคลิป tiktok')).toBe('video');
    expect(inferCreativeDomain('build a podcast episode')).toBe('video');
  });

  test('falls back to generic for unrelated goals', () => {
    expect(inferCreativeDomain('fix bug in auth.ts')).toBe('generic');
    expect(inferCreativeDomain('hello')).toBe('generic');
  });
});

describe('buildClarificationSet', () => {
  test('returns all templates when no fields are known', () => {
    const qs = buildClarificationSet({ creativeDomain: 'webtoon' });
    const ids = qs.map((q) => q.id);
    expect(ids).toContain('genre');
    expect(ids).toContain('audience');
    expect(ids).toContain('tone');
    expect(ids).toContain('length');
    expect(ids).toContain('target-platform');
  });

  test('skips templates the caller marks as known', () => {
    const qs = buildClarificationSet({
      creativeDomain: 'webtoon',
      knownFields: new Set(['audience', 'genre']),
    });
    const ids = qs.map((q) => q.id);
    expect(ids).not.toContain('audience');
    expect(ids).not.toContain('genre');
    expect(ids).toContain('tone');
  });

  test('every question allows free-text override', () => {
    const qs = buildClarificationSet({ creativeDomain: 'novel' });
    for (const q of qs) {
      expect(q.allowFreeText).toBe(true);
    }
  });

  test('genre template switches option set based on creative domain', () => {
    const webtoon = buildGenreQuestion('webtoon');
    const novel = buildGenreQuestion('novel');
    const article = buildGenreQuestion('article');

    expect(webtoon?.options?.some((o) => o.id === 'romance-fantasy')).toBe(true);
    expect(novel?.options?.some((o) => o.id === 'romance')).toBe(true);
    expect(article?.options?.some((o) => o.id === 'how-to')).toBe(true);
  });

  test('tone is a multi-select with a maxSelections soft cap', () => {
    const qs = buildClarificationSet({ creativeDomain: 'novel' });
    const tone = qs.find((q) => q.id === 'tone');
    expect(tone).toBeDefined();
    expect(tone!.kind).toBe('multi');
    expect(tone!.maxSelections).toBeGreaterThan(0);
  });
});

describe('liftStringsToStructured (back-compat shim)', () => {
  test('wraps legacy string[] questions as free-text ClarificationQuestions', () => {
    const lifted = liftStringsToStructured(['Which file?', 'What framework?']);
    expect(lifted).toHaveLength(2);
    expect(lifted[0]!.kind).toBe('free');
    expect(lifted[0]!.allowFreeText).toBe(true);
    expect(lifted[0]!.prompt).toBe('Which file?');
    expect(lifted[0]!.id).toBe('q1');
    expect(lifted[1]!.id).toBe('q2');
  });
});
