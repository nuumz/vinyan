/**
 * Adapter snapshot tests — feed each adapter a canned format request and
 * pin the shape of the produced prompt. Pure transforms, so the tests
 * make no LLM / I/O calls.
 *
 * Each adapter has its own assertions that target the grammar
 * documented in the adapter's docstring.
 */
import { describe, expect, test } from 'bun:test';
import { manualEditSpecAdapter } from '../../../src/orchestrator/specialist-prompt/adapters/manual-edit-spec.ts';
import { midjourneyV7Adapter } from '../../../src/orchestrator/specialist-prompt/adapters/midjourney-v7.ts';
import { runwayGen4Adapter } from '../../../src/orchestrator/specialist-prompt/adapters/runway-gen4.ts';
import { sunoV5Adapter } from '../../../src/orchestrator/specialist-prompt/adapters/suno-v5.ts';
import type { SpecialistFormatRequest } from '../../../src/orchestrator/specialist-prompt/types.ts';

const VIDEO_REQ: SpecialistFormatRequest = {
  goalSummary: 'Pad-Thai cooking review for a Bangkok food TikTok channel',
  synthesisOutput: [
    'Hook: We tried 3 pad-thai shops — only ONE got it right.',
    'Beat 1 — Quick pan over the three shopfronts at sunset.',
    'Beat 2 — Fast cuts of each plate; voiceover ranks them.',
    'Beat 3 — Reveal the winner; viewer save trigger ("save before your next pad-thai run").',
  ].join('\n'),
  creativeDomain: 'video',
  clarification: {
    genre: 'Food / Cooking / Eating',
    audience: 'Young Adult (18-25)',
    tone: ['Casual', 'Heartwarming'],
    length: 'Standard (30-60 วินาที)',
    platform: ['TikTok', 'Instagram Reels'],
  },
};

describe('manual-edit-spec adapter', () => {
  test('video domain — produces shot script with hook + caption + music sections', () => {
    const result = manualEditSpecAdapter(VIDEO_REQ);
    const p = result.prompt;
    // Goal heading
    expect(p).toContain('# Pad-Thai cooking review');
    // Metadata block
    expect(p).toContain('**Genre / type:**');
    expect(p).toContain('**Audience:**');
    expect(p).toContain('**Tone:**');
    expect(p).toContain('**Platform(s):** TikTok, Instagram Reels');
    // Shot-script scaffolding
    expect(p).toContain('## Hook (0:00 – 0:01.5)');
    expect(p).toContain('## Shot list');
    expect(p).toMatch(/\| Time \|.*\|.*\|.*\|/);
    expect(p).toContain('## Caption + hashtags');
    expect(p).toContain('## Music cue');
    // Original synthesis preserved
    expect(p).toContain('We tried 3 pad-thai shops');
    // TikTok algo notes attached
    expect(result.notes?.some((n) => /watch[- ]?time/i.test(n))).toBe(true);
  });

  test('music domain — produces song structure + production checklist', () => {
    const result = manualEditSpecAdapter({
      goalSummary: 'A bedtime lullaby for a 6-year-old',
      synthesisOutput: 'Sleep little one, the moon is bright...',
      creativeDomain: 'music',
      clarification: { genre: 'Lullaby', tone: ['Heartwarming'] },
    });
    expect(result.prompt).toContain('## Structure outline');
    expect(result.prompt).toContain('Verse 1');
    expect(result.prompt).toContain('Chorus');
    expect(result.prompt).toContain('## Production notes');
    expect(result.prompt).toContain('Tempo:');
  });

  test('visual domain — produces design brief with composition checklist', () => {
    const result = manualEditSpecAdapter({
      goalSummary: 'Logo for an oat-milk brand',
      synthesisOutput: 'Wordmark with rolling-oat motif, organic feel.',
      creativeDomain: 'visual',
      clarification: { genre: 'Logo', tone: ['Modern', 'Minimalist'] },
    });
    expect(result.prompt).toContain('## Composition checklist');
    expect(result.prompt).toContain('Aspect ratio');
  });

  test('generic prose domain — passes synthesis output through under a Deliverable heading', () => {
    const result = manualEditSpecAdapter({
      goalSummary: 'Q4 OKR memo for the board',
      synthesisOutput: 'OKR 1: Reduce churn from 4.5% to 3% by end of Q4...',
      creativeDomain: 'business',
    });
    expect(result.prompt).toContain('## Deliverable');
    expect(result.prompt).toContain('OKR 1: Reduce churn');
  });

  test('no clarification answers — emits a placeholder line', () => {
    const result = manualEditSpecAdapter({
      goalSummary: 'just a goal',
      synthesisOutput: 'body',
      creativeDomain: 'generic',
    });
    expect(result.prompt).toContain('_(no clarification answers provided)_');
  });
});

describe('runway-gen-4.5 adapter', () => {
  test('lead with subject, attach aspect-ratio + motion + duration', () => {
    const result = runwayGen4Adapter(VIDEO_REQ);
    expect(result.prompt).toMatch(/Subject \/ scene:.*Pad-Thai/i);
    expect(result.prompt).toContain('Aspect ratio: 9:16');
    expect(result.prompt).toContain('Duration: 10 seconds');
    expect(result.prompt).toMatch(/Motion score: \d+\/10/);
    expect(result.parameters?.aspectRatio).toBe('9:16');
    expect(result.parameters?.durationSec).toBe(10);
    expect(result.parameters?.motionScore).toBe(5);
  });

  test('caller parameters override defaults', () => {
    const result = runwayGen4Adapter({
      ...VIDEO_REQ,
      parameters: { aspectRatio: '16:9', motionScore: 8 },
    });
    expect(result.parameters?.aspectRatio).toBe('16:9');
    expect(result.parameters?.motionScore).toBe(8);
    expect(result.parameters?.durationSec).toBe(10); // default preserved
    expect(result.prompt).toContain('Aspect ratio: 16:9');
  });
});

describe('suno-v5 adapter', () => {
  test('genre + BPM at the start, lyric block in the middle, mode tag at the end', () => {
    const result = sunoV5Adapter({
      goalSummary: 'Heartbreak pop song',
      synthesisOutput: "[Verse 1]\nWalking past your door tonight\n[Chorus]\nNow I'm alone again",
      creativeDomain: 'music',
      clarification: { genre: 'Pop', audience: 'Young Adult (18-25)', tone: ['melancholic'] },
      parameters: { bpm: 92 },
    });
    const lines = result.prompt.split('\n').filter(Boolean);
    expect(lines[0]).toContain('Pop');
    expect(lines[0]).toContain('92 BPM');
    expect(result.prompt).toContain('[Verse 1]');
    expect(result.prompt).toContain('[Chorus]');
    expect(result.prompt).toContain('Mode: lyric');
    expect(result.parameters?.bpm).toBe(92);
  });

  test('synthesis without section markers gets wrapped in a [Verse] block', () => {
    const result = sunoV5Adapter({
      goalSummary: 'Lo-fi study track',
      synthesisOutput: 'Soft rain on the window pane, a cup of tea, page after page.',
      creativeDomain: 'music',
      clarification: { genre: 'Lo-fi' },
    });
    expect(result.prompt).toContain('[Verse]');
    expect(result.prompt).toContain('Lo-fi');
  });
});

describe('midjourney-v7 adapter', () => {
  test('subject prefix + flags suffix; respects aspect ratio override', () => {
    const result = midjourneyV7Adapter({
      goalSummary: 'Editorial illustration of a Bangkok rainy season',
      synthesisOutput: 'Wet neon street, lone umbrella, soft reflections',
      creativeDomain: 'visual',
      clarification: { tone: ['Vintage'] },
      parameters: { aspectRatio: '9:16', styleRaw: true },
    });
    expect(result.prompt).toContain('Wet neon street');
    expect(result.prompt).toContain('Vintage');
    expect(result.prompt).toContain('--ar 9:16');
    expect(result.prompt).toContain('--v 7');
    expect(result.prompt).toContain('--style raw');
    expect(result.parameters?.aspectRatio).toBe('9:16');
  });

  test('caps subject line at ~280 chars', () => {
    const longBody = 'pixelated panorama, '.repeat(30);
    const result = midjourneyV7Adapter({
      goalSummary: 'Stress test',
      synthesisOutput: longBody,
      creativeDomain: 'visual',
    });
    // Find the subject portion (before the flags) — strip flags and check length
    const beforeFlags = result.prompt.split('--')[0]!;
    expect(beforeFlags.length).toBeLessThanOrEqual(285);
  });
});
