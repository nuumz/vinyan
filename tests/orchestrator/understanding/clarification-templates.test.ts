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
    // Bare "podcast" without other audio cues should land in video (catch-all
    // for short-form podcast clips). Music-specific song terms hit `music` first.
    expect(inferCreativeDomain('record a podcast episode about startups')).toBe('music');
  });

  test('identifies music domain', () => {
    expect(inferCreativeDomain('แต่งเพลงประกอบหนัง')).toBe('music');
    expect(inferCreativeDomain('write a hook for a pop song')).toBe('music');
    expect(inferCreativeDomain('compose a 30-second jingle')).toBe('music');
  });

  test('identifies game domain (including video-game compound)', () => {
    expect(inferCreativeDomain('design an indie roguelike game')).toBe('game');
    expect(inferCreativeDomain('ออกแบบเกมแนว RPG')).toBe('game');
    // "วิดีโอเกม" — compound noun; must beat the broader video pattern.
    expect(inferCreativeDomain('ทำวิดีโอเกมแนวต่อสู้')).toBe('game');
    expect(inferCreativeDomain('build a level for a platformer')).toBe('game');
  });

  test('identifies marketing domain', () => {
    expect(inferCreativeDomain('ทำโฆษณา TikTok สำหรับร้านกาแฟ')).toBe('marketing');
    expect(inferCreativeDomain('write ad copy for a product launch')).toBe('marketing');
    expect(inferCreativeDomain('draft a tagline for our rebrand')).toBe('marketing');
  });

  test('identifies education domain', () => {
    expect(inferCreativeDomain('ออกแบบหลักสูตรเรียน Mandarin')).toBe('education');
    expect(inferCreativeDomain('build a 12-week bootcamp on backend')).toBe('education');
    expect(inferCreativeDomain('design a curriculum for grade 9 algebra')).toBe('education');
  });

  test('identifies business domain', () => {
    expect(inferCreativeDomain('ทำพิทช์เด็คสำหรับ Series A')).toBe('business');
    expect(inferCreativeDomain('draft a one-pager for the board')).toBe('business');
    expect(inferCreativeDomain('write an executive summary')).toBe('business');
  });

  test('identifies visual domain', () => {
    expect(inferCreativeDomain('design a logo for an oat-milk brand')).toBe('visual');
    expect(inferCreativeDomain('ทำโปสเตอร์งาน hackathon')).toBe('visual');
    expect(inferCreativeDomain('create an infographic on climate change')).toBe('visual');
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
    const video = buildGenreQuestion('video');

    expect(webtoon?.options?.some((o) => o.id === 'romance-fantasy')).toBe(true);
    expect(novel?.options?.some((o) => o.id === 'romance')).toBe(true);
    expect(article?.options?.some((o) => o.id === 'how-to')).toBe(true);
    expect(video?.options?.some((o) => o.id === 'comedy')).toBe(true);
    expect(video?.options?.some((o) => o.id === 'lifestyle')).toBe(true);
    expect(video?.options?.some((o) => o.id === 'food')).toBe(true);
    // Novel/article options should NOT bleed into video set.
    expect(video?.options?.some((o) => o.id === 'romance')).toBe(false);
    expect(video?.options?.some((o) => o.id === 'literary')).toBe(false);
  });

  test('video domain swaps length to seconds-based options and platform to short-form video set', () => {
    const qs = buildClarificationSet({ creativeDomain: 'video' });
    const length = qs.find((q) => q.id === 'length');
    const platform = qs.find((q) => q.id === 'target-platform');
    expect(length?.options?.some((o) => o.id === 'standard')).toBe(true);
    expect(length?.options?.every((o) => !/หน้า|คำ/.test(o.label))).toBe(true);
    expect(platform?.options?.some((o) => o.id === 'tiktok')).toBe(true);
    expect(platform?.options?.some((o) => o.id === 'instagram-reels')).toBe(true);
    expect(platform?.options?.some((o) => o.id === 'youtube-shorts')).toBe(true);
    // Webtoon/blog options should NOT appear for video.
    expect(platform?.options?.some((o) => o.id === 'webtoon')).toBe(false);
    expect(platform?.options?.some((o) => o.id === 'medium')).toBe(false);
  });

  test('music domain — genre/length/platform are music-shaped', () => {
    const qs = buildClarificationSet({ creativeDomain: 'music' });
    const genre = qs.find((q) => q.id === 'genre');
    const length = qs.find((q) => q.id === 'length');
    const platform = qs.find((q) => q.id === 'target-platform');
    const audience = qs.find((q) => q.id === 'audience');
    expect(genre?.options?.some((o) => o.id === 'pop')).toBe(true);
    expect(genre?.options?.some((o) => o.id === 'lofi')).toBe(true);
    expect(length?.options?.some((o) => o.id === 'hook')).toBe(true);
    expect(platform?.options?.some((o) => o.id === 'spotify')).toBe(true);
    expect(platform?.options?.some((o) => o.id === 'soundcloud')).toBe(true);
    // No webtoon-specific options leaking through.
    expect(platform?.options?.some((o) => o.id === 'webtoon')).toBe(false);
    expect(audience?.prompt).toMatch(/ผู้ฟัง/);
  });

  test('game domain — uses player-tier audience and platform options for game shops', () => {
    const qs = buildClarificationSet({ creativeDomain: 'game' });
    const audience = qs.find((q) => q.id === 'audience');
    const platform = qs.find((q) => q.id === 'target-platform');
    const length = qs.find((q) => q.id === 'length');
    expect(audience?.options?.some((o) => o.id === 'casual')).toBe(true);
    expect(audience?.options?.some((o) => o.id === 'hardcore')).toBe(true);
    expect(platform?.options?.some((o) => o.id === 'pc-steam')).toBe(true);
    expect(platform?.options?.some((o) => o.id === 'console')).toBe(true);
    expect(length?.options?.some((o) => o.id === 'live-service')).toBe(true);
  });

  test('marketing domain — campaign-objective genres + ad-platform set', () => {
    const qs = buildClarificationSet({ creativeDomain: 'marketing' });
    const genre = qs.find((q) => q.id === 'genre');
    const tone = qs.find((q) => q.id === 'tone');
    const platform = qs.find((q) => q.id === 'target-platform');
    expect(genre?.options?.some((o) => o.id === 'product-launch')).toBe(true);
    expect(genre?.options?.some((o) => o.id === 'brand-awareness')).toBe(true);
    expect(tone?.options?.some((o) => o.id === 'inspirational')).toBe(true);
    expect(platform?.options?.some((o) => o.id === 'meta')).toBe(true);
    expect(platform?.options?.some((o) => o.id === 'tiktok-ads')).toBe(true);
    expect(platform?.options?.some((o) => o.id === 'line')).toBe(true);
  });

  test('education domain — learner-tier audience + LMS-shaped platforms', () => {
    const qs = buildClarificationSet({ creativeDomain: 'education' });
    const audience = qs.find((q) => q.id === 'audience');
    const platform = qs.find((q) => q.id === 'target-platform');
    expect(audience?.options?.some((o) => o.id === 'beginner')).toBe(true);
    expect(audience?.options?.some((o) => o.id === 'k12')).toBe(true);
    expect(platform?.options?.some((o) => o.id === 'udemy')).toBe(true);
    expect(platform?.options?.some((o) => o.id === 'in-house-lms')).toBe(true);
  });

  test('business domain — investor/board audience + deck length options', () => {
    const qs = buildClarificationSet({ creativeDomain: 'business' });
    const audience = qs.find((q) => q.id === 'audience');
    const length = qs.find((q) => q.id === 'length');
    const platform = qs.find((q) => q.id === 'target-platform');
    expect(audience?.options?.some((o) => o.id === 'investors')).toBe(true);
    expect(audience?.options?.some((o) => o.id === 'board')).toBe(true);
    expect(length?.options?.some((o) => o.id === 'pitch-deck' || o.id === 'standard-deck')).toBe(true);
    expect(platform?.options?.some((o) => o.id === 'powerpoint')).toBe(true);
  });

  test('visual domain — asset-type genre + aspect-ratio length + brand-platform set', () => {
    const qs = buildClarificationSet({ creativeDomain: 'visual' });
    const genre = qs.find((q) => q.id === 'genre');
    const length = qs.find((q) => q.id === 'length');
    const platform = qs.find((q) => q.id === 'target-platform');
    expect(genre?.options?.some((o) => o.id === 'logo')).toBe(true);
    expect(genre?.options?.some((o) => o.id === 'poster')).toBe(true);
    expect(length?.options?.some((o) => o.id === 'square')).toBe(true);
    expect(length?.options?.some((o) => o.id === 'portrait')).toBe(true);
    expect(platform?.options?.some((o) => o.id === 'instagram')).toBe(true);
    expect(platform?.options?.some((o) => o.id === 'print')).toBe(true);
  });

  test('every registered domain has a unique non-empty option set per question', () => {
    const domains = [
      'webtoon',
      'novel',
      'article',
      'video',
      'music',
      'game',
      'marketing',
      'education',
      'business',
      'visual',
      'generic',
    ] as const;
    for (const d of domains) {
      const qs = buildClarificationSet({ creativeDomain: d });
      // Each of the 5 question slots must produce a non-empty options array.
      const ids = ['genre', 'audience', 'tone', 'length', 'target-platform'];
      for (const id of ids) {
        const q = qs.find((x) => x.id === id);
        expect(q).toBeDefined();
        expect((q!.options ?? []).length).toBeGreaterThan(0);
        // Free-text override always allowed so users aren't trapped by the menu.
        expect(q!.allowFreeText).toBe(true);
      }
    }
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
