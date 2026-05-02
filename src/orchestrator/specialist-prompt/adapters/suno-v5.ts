/**
 * `suno-v5` adapter — formats a creative brief for Suno v5's lyric-block
 * grammar.
 *
 * Suno prompts in 2026 weight on:
 *   1. Genre + era + sub-genre tags at the START (Suno weights the
 *      beginning of the prompt heavily).
 *   2. Section headers: `[Verse 1]`, `[Pre-chorus]`, `[Chorus]`,
 *      `[Bridge]`, `[Outro]` — explicit section markers improve
 *      structure recall.
 *   3. Style metadata at the END: `(BPM, mood, instrumentation)`.
 *
 * Suno Studio (paid) takes either a "lyric" mode (full song) or
 * "instrumental" mode (no vocals). When the synthesised content does
 * NOT contain section headers, this adapter wraps it with a single
 * `[Verse]` block as a safe default.
 *
 * Pure transform — no I/O.
 */

import type { SpecialistAdapter, SpecialistFormatRequest, SpecialistFormatResponse } from '../types.ts';

const DEFAULT_PARAMETERS = {
  bpm: 100,
  mode: 'lyric', // 'lyric' | 'instrumental'
} as const;

const NOTES = [
  'Suno weights the FIRST tokens of the prompt — lead with genre + era + tempo, save mood for the end.',
  'Use `[Section]` markers explicitly. Suno respects `[Verse 1]`, `[Pre-chorus]`, `[Chorus]`, `[Bridge]`, `[Outro]`.',
  'Switch to `instrumental` mode when the user asked for a backing track / score — vocals are omitted.',
];

const SECTION_MARKER_RE = /\[(Verse|Chorus|Pre-chorus|Bridge|Intro|Outro|Hook)/i;

export const sunoV5Adapter: SpecialistAdapter = (req: SpecialistFormatRequest): SpecialistFormatResponse => {
  const params = mergeParams(req);
  const styleHeader = buildStyleHeader(req, params);
  const lyricBlock = ensureSectionMarkers(req.synthesisOutput.trim());
  const tail = buildStyleTail(req, params);
  const prompt = `${styleHeader}\n\n${lyricBlock}\n\n${tail}`;
  return {
    prompt,
    parameters: params,
    notes: NOTES,
  };
};

function buildStyleHeader(req: SpecialistFormatRequest, params: Record<string, string | number | boolean>): string {
  const c = req.clarification ?? {};
  const segments: string[] = [];
  if (c.genre) segments.push(c.genre);
  if (c.tone && c.tone.length > 0) segments.push(c.tone.join(' & '));
  segments.push(`${params.bpm} BPM`);
  // Suno weights early tokens — keep this comma-joined and tight.
  return segments.length > 1 ? segments.join(', ') : `pop, ${params.bpm} BPM`;
}

function buildStyleTail(req: SpecialistFormatRequest, params: Record<string, string | number | boolean>): string {
  const c = req.clarification ?? {};
  const tail: string[] = [];
  if (c.audience) tail.push(`Audience: ${c.audience}`);
  if (c.length) tail.push(`Target length: ${c.length}`);
  tail.push(`Mode: ${params.mode}`);
  return `(${tail.join(' · ')})`;
}

function ensureSectionMarkers(text: string): string {
  if (SECTION_MARKER_RE.test(text)) return text;
  // Wrap the entire body as a single Verse so Suno still gets a marker.
  return `[Verse]\n${text}`;
}

function mergeParams(req: SpecialistFormatRequest): Record<string, string | number | boolean> {
  const merged: Record<string, string | number | boolean> = { ...DEFAULT_PARAMETERS };
  if (req.parameters) {
    for (const [k, v] of Object.entries(req.parameters)) {
      if (v !== undefined) merged[k] = v;
    }
  }
  return merged;
}
