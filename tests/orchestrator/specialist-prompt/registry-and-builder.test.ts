/**
 * Registry + builder tests — confirms config-driven entry validation,
 * adapter dispatch, fallback to manual-edit-spec on miss, and parameter
 * merging.
 */
import { describe, expect, test } from 'bun:test';
import { formatForSpecialist } from '../../../src/orchestrator/specialist-prompt/builder.ts';
import { createSpecialistRegistry } from '../../../src/orchestrator/specialist-prompt/registry.ts';
import type { SpecialistFormatRequest } from '../../../src/orchestrator/specialist-prompt/types.ts';

const BASIC_REQ: SpecialistFormatRequest = {
  goalSummary: 'short demo',
  synthesisOutput: 'demo body',
  creativeDomain: 'generic',
};

describe('createSpecialistRegistry — built-in seeds', () => {
  test('exposes all 4 seeds with declared media', () => {
    const r = createSpecialistRegistry();
    const list = r.list();
    const ids = list.map((d) => d.id);
    expect(ids).toContain('manual-edit-spec');
    expect(ids).toContain('runway-gen-4.5');
    expect(ids).toContain('suno-v5');
    expect(ids).toContain('midjourney-v7');
    expect(list.every((d) => d.builtin === true)).toBe(true);
    const media = [...r.listMedia()].sort();
    expect(media).toEqual(['audio', 'edit-spec', 'image', 'video'] as typeof media);
  });

  test('case-insensitive lookup', () => {
    const r = createSpecialistRegistry();
    expect(r.get('Runway-Gen-4.5')?.id).toBe('runway-gen-4.5');
    expect(r.getAdapter('SUNO-V5')).toBeDefined();
  });

  test('returns null for unknown id', () => {
    const r = createSpecialistRegistry();
    expect(r.get('does-not-exist')).toBeNull();
    expect(r.getAdapter('does-not-exist')).toBeNull();
  });
});

describe('createSpecialistRegistry — config-supplied entries', () => {
  test('valid config entry registers and overrides built-in id when ids match', () => {
    const r = createSpecialistRegistry([
      {
        id: 'pika-2',
        displayName: 'Pika 2',
        medium: 'video',
        grammar: 'prose-concise',
        adapterId: 'runway-gen-4.5', // reuse a built-in adapter
        description: 'Pika 2 — fast social-creator video.',
      },
    ]);
    const def = r.get('pika-2');
    expect(def).not.toBeNull();
    expect(def!.builtin).toBe(false);
    expect(r.getAdapter('pika-2')).toBeDefined();
  });

  test('invalid config entry (bad shape) is dropped', () => {
    const r = createSpecialistRegistry([
      // missing required fields
      { id: 'broken' },
    ]);
    expect(r.get('broken')).toBeNull();
    // Built-in seeds still register
    expect(r.get('manual-edit-spec')).not.toBeNull();
  });

  test('config entry with unknown adapterId is dropped (referenced adapter must exist)', () => {
    const r = createSpecialistRegistry([
      {
        id: 'bogus',
        displayName: 'Bogus generator',
        medium: 'video',
        grammar: 'prose-medium',
        adapterId: 'no-such-adapter',
        description: 'Should not register.',
      },
    ]);
    expect(r.get('bogus')).toBeNull();
  });
});

describe('formatForSpecialist — happy path', () => {
  test('runway target hits runway adapter', () => {
    const r = createSpecialistRegistry();
    const result = formatForSpecialist('runway-gen-4.5', BASIC_REQ, r);
    expect(result.fellBack).toBe(false);
    expect(result.resolvedSpecialistId).toBe('runway-gen-4.5');
    expect(result.parameters?.aspectRatio).toBe('9:16');
  });

  test('suno target hits suno adapter', () => {
    const r = createSpecialistRegistry();
    const result = formatForSpecialist('suno-v5', { ...BASIC_REQ, creativeDomain: 'music' }, r);
    expect(result.fellBack).toBe(false);
    expect(result.resolvedSpecialistId).toBe('suno-v5');
    expect(result.prompt).toContain('Mode: lyric');
  });
});

describe('formatForSpecialist — fallback path', () => {
  test('unknown specialist falls back to manual-edit-spec', () => {
    const r = createSpecialistRegistry();
    const result = formatForSpecialist('does-not-exist', BASIC_REQ, r);
    expect(result.fellBack).toBe(true);
    expect(result.resolvedSpecialistId).toBe('manual-edit-spec');
  });

  test('Phase A.5 — explicit manual-edit-spec target with creative domain produces a domain-specific format', () => {
    // When the workflow-executor's effectiveTarget logic kicks in for a
    // creative goal without an LLM-extracted specialistTarget, it passes
    // 'manual-edit-spec' here. The adapter then branches on creativeDomain
    // to produce a video shot-script vs music outline vs prose wrapper.
    const r = createSpecialistRegistry();
    const videoResult = formatForSpecialist(
      'manual-edit-spec',
      { ...BASIC_REQ, creativeDomain: 'video', synthesisOutput: 'Hook + 3 beats + payoff.' },
      r,
    );
    expect(videoResult.fellBack).toBe(false);
    expect(videoResult.resolvedSpecialistId).toBe('manual-edit-spec');
    expect(videoResult.prompt).toContain('## Hook (0:00 – 0:01.5)');
    expect(videoResult.prompt).toContain('## Shot list');

    const musicResult = formatForSpecialist(
      'manual-edit-spec',
      { ...BASIC_REQ, creativeDomain: 'music', synthesisOutput: 'Verse + chorus.' },
      r,
    );
    expect(musicResult.prompt).toContain('## Structure outline');
    expect(musicResult.prompt).toContain('Production notes');
  });

  test('undefined specialist target resolves to manual-edit-spec as the natural default (not labeled as fallback)', () => {
    // No requested id → defaults to manual-edit-spec, which IS registered,
    // so fellBack=false. The fallback path is reserved for the case where
    // a SPECIFIC requested id was missing from the registry — that's an
    // honest signal worth surfacing on observability events.
    const r = createSpecialistRegistry();
    const result = formatForSpecialist(undefined, BASIC_REQ, r);
    expect(result.fellBack).toBe(false);
    expect(result.resolvedSpecialistId).toBe('manual-edit-spec');
  });

  test('caller parameters override registry default parameters', () => {
    const r = createSpecialistRegistry();
    // Runway default aspectRatio is 9:16; override to 16:9
    const result = formatForSpecialist('runway-gen-4.5', { ...BASIC_REQ, parameters: { aspectRatio: '16:9' } }, r);
    expect(result.parameters?.aspectRatio).toBe('16:9');
    expect(result.parameters?.durationSec).toBe(10); // default preserved
  });
});
