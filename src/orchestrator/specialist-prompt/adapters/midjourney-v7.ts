/**
 * `midjourney-v7` adapter — formats a creative brief for Midjourney v7's
 * subject-style-flags grammar.
 *
 * Midjourney prompts in 2026:
 *   1. Subject + composition first (concise — long prose dilutes
 *      attention). Midjourney is the most "concise prompts win" of the
 *      raster generators.
 *   2. Style modifiers next: `cinematic`, `editorial`, `pastel`,
 *      `photorealistic`, `flat illustration`, `oil painting`, …
 *   3. Flags at the end: `--ar 9:16 --v 7 --style raw --s 250`.
 *
 * Pure transform — no I/O.
 */

import type { SpecialistAdapter, SpecialistFormatRequest, SpecialistFormatResponse } from '../types.ts';

const DEFAULT_PARAMETERS = {
  aspectRatio: '1:1',
  styleStrength: 250,
  version: 7,
  styleRaw: false,
} as const;

const NOTES = [
  'Midjourney rewards concise prompts. Lead with the subject + one composition cue, then 2–4 style modifiers.',
  'Use `--style raw` for photorealism / minimal default styling; omit for the painterly default.',
  'Aspect ratio defaults to 1:1. Use `9:16` for Reels / Story / portrait, `16:9` for landscape banners.',
];

export const midjourneyV7Adapter: SpecialistAdapter = (req: SpecialistFormatRequest): SpecialistFormatResponse => {
  const params = mergeParams(req);
  const subject = buildSubjectLine(req);
  const flags = buildFlags(params);
  const prompt = `${subject} ${flags}`.trim();
  return {
    prompt,
    parameters: params,
    notes: NOTES,
  };
};

function buildSubjectLine(req: SpecialistFormatRequest): string {
  // Midjourney prefers concise, comma-separated descriptors. Take the
  // synthesisOutput's first two non-empty lines as the subject + style;
  // anything after is dropped to keep the prompt short. The user's
  // free-text override (if supplied) takes precedence.
  const c = req.clarification ?? {};
  const freeStyle = c.freeText?.style ?? c.freeText?.subject;
  if (freeStyle) return freeStyle.trim();
  const lines = req.synthesisOutput
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 3);
  let subject = lines.join(', ');
  if (c.tone && c.tone.length > 0) subject = `${subject}, ${c.tone.join(', ')}`;
  // Cap to ~280 chars — Midjourney's effective prompt window is short.
  if (subject.length > 280) subject = `${subject.slice(0, 277)}…`;
  return subject;
}

function buildFlags(params: Record<string, string | number | boolean>): string {
  const flags: string[] = [];
  flags.push(`--ar ${params.aspectRatio}`);
  flags.push(`--v ${params.version}`);
  if (params.styleRaw) flags.push('--style raw');
  if (typeof params.styleStrength === 'number') flags.push(`--s ${params.styleStrength}`);
  return flags.join(' ');
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
