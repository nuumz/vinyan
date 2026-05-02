/**
 * `runway-gen-4.5` adapter — formats a creative brief for Runway's
 * Image-to-Video / Text-to-Video grammar.
 *
 * Runway prompts in 2026 weight on:
 *   1. Subject + action (what is moving)
 *   2. Camera move (dolly, pan, push-in, handheld) and shot scale
 *   3. Lighting + atmosphere (golden hour, neon, overcast)
 *   4. Reference image hint (Runway's defining feature; mention if the
 *      user has a reference still in mind so the operator knows to upload one)
 *
 * The adapter assembles a medium-detail prose prompt, then attaches a
 * structured `parameters` object for Runway-API callers (aspect ratio,
 * motion score, seed, duration). This is consistent with the May 2026
 * landscape: Runway Gen-4.5 takes 5 / 10-second clips at 9:16 or 16:9
 * with motion control.
 *
 * Pure transform — no I/O. The `synthesisOutput` is the source of truth
 * for the scene; we frame it with the Runway-specific scaffolding.
 */

import type { SpecialistAdapter, SpecialistFormatRequest, SpecialistFormatResponse } from '../types.ts';

const DEFAULT_PARAMETERS = {
  aspectRatio: '9:16',
  durationSec: 10,
  motionScore: 5,
} as const;

const NOTES = [
  'Runway prompts weight the FIRST sentence — lead with subject + action, save style modifiers for later.',
  "If you have a reference still, upload it in Runway and include the upload note here. Reference image consistency is Runway Gen-4.5's strongest feature.",
  'Motion score 1-10. Default 5. Lower (2-3) for talking-head + subtle motion; higher (7-9) for action / camera-driven shots.',
];

export const runwayGen4Adapter: SpecialistAdapter = (req: SpecialistFormatRequest): SpecialistFormatResponse => {
  const params = mergeParams(req);
  const prompt = buildPrompt(req, params);
  return {
    prompt,
    parameters: params,
    notes: NOTES,
  };
};

function buildPrompt(req: SpecialistFormatRequest, params: Record<string, string | number | boolean>): string {
  const lines: string[] = [];
  lines.push(`Subject / scene: ${req.goalSummary}`);
  lines.push('');
  lines.push('Scene description:');
  lines.push(req.synthesisOutput.trim());
  lines.push('');
  // Tone hint, when supplied, influences the Runway visual mood — surface it
  // explicitly because Runway weights early tokens.
  const c = req.clarification ?? {};
  if (c.tone && c.tone.length > 0) {
    lines.push(`Mood / tone: ${c.tone.join(', ')}.`);
  }
  if (c.platform && c.platform.length > 0) {
    lines.push(`Distribution platform: ${c.platform.join(', ')}.`);
  }
  lines.push('');
  lines.push(`Aspect ratio: ${params.aspectRatio}.`);
  lines.push(`Duration: ${params.durationSec} seconds.`);
  lines.push(`Motion score: ${params.motionScore}/10.`);
  lines.push('Cinematic film grain, professional colour grade.');
  return lines.join('\n');
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
