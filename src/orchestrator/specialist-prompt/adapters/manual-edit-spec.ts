/**
 * `manual-edit-spec` adapter — the default for creative tasks where
 * Vinyan does NOT hand the artefact to a generative AI specialist.
 *
 * Why this is the default for video.
 * TikTok's 2026 algorithm down-ranks raw AI-generated video. Creators
 * who use AI as a tool but still cut/edit the final output via CapCut /
 * Premiere / DaVinci see materially better watch-time + save rates. The
 * plan calls for `manual-edit-spec` as the default contract whenever the
 * IntentResolver does not attach an explicit `specialistTarget`.
 *
 * Output shape (markdown).
 *   - For `video` / `marketing`: shot list with timestamps + voiceover +
 *     B-roll + on-screen text + caption + hashtags + music cue
 *   - For `music`: song structure (Verse/Chorus/Bridge) + lyric draft +
 *     mood/tempo/instrumentation guidance for a human producer
 *   - For `visual`: composition + reference style + mood + colour notes
 *   - For `novel` / `article` / `webtoon` / `business` / `education` /
 *     `game` / `generic`: pass-through prose with structured framing
 *     headers (target, audience, length, tone). The synthesised text
 *     is the deliverable; this adapter just adds metadata + acceptance
 *     criteria so a human-in-the-loop reviewer has a checklist.
 *
 * This adapter is pure — no LLM, no I/O. Same `SpecialistFormatRequest`
 * always produces the same response. Adapters live downstream of the
 * smart clarification gate, so the `clarification` field is usually
 * present; we degrade gracefully when the user skipped clarification.
 */

import type { SpecialistAdapter, SpecialistFormatRequest, SpecialistFormatResponse } from '../types.ts';

const DEFAULT_NOTES_VIDEO: string[] = [
  'TikTok 2026 algorithm rewards watch-time + saves over raw views — design the hook to land in the first 1.5 seconds.',
  'Length-adjusted completion rate is the dominant ranking signal; a tight 30-second cut beats a meandering 60.',
  'Cross-post to Reels + YouTube Shorts when the platform list permits — single-platform reach is materially weaker in 2026.',
];

const DEFAULT_NOTES_MUSIC: string[] = [
  'Suno / Udio prompts weight the OPENING tokens — when handing this to a generator, lead with genre + era + tempo.',
  'Lyric blocks should be self-contained (Verse / Chorus / Bridge). Avoid running prose lines together.',
];

const DEFAULT_NOTES_VISUAL: string[] = [
  'When briefing a designer or AI image tool, lead with subject + composition + lighting before style modifiers.',
  'Specify aspect ratio explicitly (square / portrait 9:16 / landscape 16:9) — defaults vary by tool.',
];

export const manualEditSpecAdapter: SpecialistAdapter = (req: SpecialistFormatRequest): SpecialistFormatResponse => {
  const domain = req.creativeDomain ?? 'generic';
  switch (domain) {
    case 'video':
    case 'marketing':
      return formatVideo(req);
    case 'music':
      return formatMusic(req);
    case 'visual':
      return formatVisual(req);
    default:
      return formatGenericProse(req);
  }
};

// ── Video / marketing ────────────────────────────────────────────────────

function formatVideo(req: SpecialistFormatRequest): SpecialistFormatResponse {
  const lines: string[] = [];
  lines.push(`# ${req.goalSummary}`);
  lines.push('');
  lines.push(metadataBlock(req));
  lines.push('');
  lines.push('## Output contract');
  lines.push('Format: shot-by-shot edit script for human / NLE editor.');
  lines.push('Hand-off target: CapCut / Premiere / DaVinci — NOT a generative video model.');
  lines.push('');
  lines.push('## Hook (0:00 – 0:01.5)');
  lines.push(
    'Open with a pattern-interrupt visual + on-screen hook line. The hook must land in 1.5 seconds for TikTok-class platforms.',
  );
  lines.push('');
  lines.push('## Shot list');
  lines.push('Use this template — fill timestamps + on-screen text from the synthesis output below.');
  lines.push('');
  lines.push('| Time | Shot description | Voiceover / on-screen text | B-roll / FX |');
  lines.push('|---|---|---|---|');
  lines.push('| 0:00 – 0:01.5 | (hook) | … | … |');
  lines.push('| 0:01.5 – … | (build) | … | … |');
  lines.push('| … – end | (payoff / save-trigger) | … | … |');
  lines.push('');
  lines.push('## Caption + hashtags');
  lines.push(
    'Caption: 1–2 lines. End with a save-trigger ("save this for next time you …") to lift the dominant 2026 ranking signal.',
  );
  lines.push(
    'Hashtags: 6–10 ranked from broadest to most niche. Mix at least one trending tag with two niche-specific tags.',
  );
  lines.push('');
  lines.push('## Music cue');
  lines.push(
    'Suggest tempo (BPM), mood, and a sample reference (artist or licensed-library track). Confirm rights before publishing.',
  );
  lines.push('');
  lines.push('## Synthesised script (use as the source of truth)');
  lines.push('');
  lines.push(req.synthesisOutput.trim());
  return {
    prompt: lines.join('\n'),
    notes: DEFAULT_NOTES_VIDEO,
  };
}

// ── Music ────────────────────────────────────────────────────────────────

function formatMusic(req: SpecialistFormatRequest): SpecialistFormatResponse {
  const lines: string[] = [];
  lines.push(`# ${req.goalSummary}`);
  lines.push('');
  lines.push(metadataBlock(req));
  lines.push('');
  lines.push('## Output contract');
  lines.push(
    'Format: song structure + lyric draft + production notes for a human producer (or as a pre-prompt brief for Suno / Udio).',
  );
  lines.push('');
  lines.push('## Structure outline');
  lines.push(
    'Recommended sections: Intro · Verse 1 · Pre-chorus · Chorus · Verse 2 · Chorus · Bridge · Final chorus · Outro. Adjust per genre.',
  );
  lines.push('');
  lines.push('## Lyric draft (synthesised)');
  lines.push('');
  lines.push(req.synthesisOutput.trim());
  lines.push('');
  lines.push('## Production notes');
  lines.push('- Tempo: (BPM)');
  lines.push('- Key / mode: ');
  lines.push('- Lead instruments: ');
  lines.push('- Reference tracks (for vibe alignment): ');
  return {
    prompt: lines.join('\n'),
    notes: DEFAULT_NOTES_MUSIC,
  };
}

// ── Visual ───────────────────────────────────────────────────────────────

function formatVisual(req: SpecialistFormatRequest): SpecialistFormatResponse {
  const lines: string[] = [];
  lines.push(`# ${req.goalSummary}`);
  lines.push('');
  lines.push(metadataBlock(req));
  lines.push('');
  lines.push('## Output contract');
  lines.push('Format: design brief for a human designer (or pre-prompt brief for Midjourney / Flux / DALL-E).');
  lines.push('');
  lines.push('## Brief (synthesised)');
  lines.push('');
  lines.push(req.synthesisOutput.trim());
  lines.push('');
  lines.push('## Composition checklist');
  lines.push('- Subject (what is the focal element):');
  lines.push('- Composition / framing:');
  lines.push('- Lighting / colour palette:');
  lines.push('- Style modifiers (vintage / minimalist / bold / …):');
  lines.push('- Aspect ratio (square / 9:16 / 16:9 / A4):');
  return {
    prompt: lines.join('\n'),
    notes: DEFAULT_NOTES_VISUAL,
  };
}

// ── Generic prose (novel / article / webtoon / business / education / game) ─

function formatGenericProse(req: SpecialistFormatRequest): SpecialistFormatResponse {
  const lines: string[] = [];
  lines.push(`# ${req.goalSummary}`);
  lines.push('');
  lines.push(metadataBlock(req));
  lines.push('');
  lines.push('## Deliverable');
  lines.push('');
  lines.push(req.synthesisOutput.trim());
  return {
    prompt: lines.join('\n'),
  };
}

// ── Shared metadata block ────────────────────────────────────────────────

function metadataBlock(req: SpecialistFormatRequest): string {
  const c = req.clarification ?? {};
  const rows: string[] = [];
  if (c.genre) rows.push(`- **Genre / type:** ${c.genre}`);
  if (c.audience) rows.push(`- **Audience:** ${c.audience}`);
  if (c.tone && c.tone.length > 0) rows.push(`- **Tone:** ${c.tone.join(', ')}`);
  if (c.length) rows.push(`- **Length:** ${c.length}`);
  if (c.platform && c.platform.length > 0) rows.push(`- **Platform(s):** ${c.platform.join(', ')}`);
  if (c.freeText && Object.keys(c.freeText).length > 0) {
    for (const [k, v] of Object.entries(c.freeText)) {
      if (v) rows.push(`- **${k}:** ${v}`);
    }
  }
  if (rows.length === 0) return '_(no clarification answers provided)_';
  return rows.join('\n');
}
