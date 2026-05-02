/**
 * SpecialistRegistry — config-driven catalogue of downstream generators
 * Vinyan can format final prompts for.
 *
 * The registry has two layers:
 *
 *   1. **Built-in seeds** (ship with Vinyan, declared in this file).
 *      These are well-known, stable specialist + adapter pairs that
 *      work out of the box.
 *
 *   2. **Config-supplied entries** (loaded from `vinyan.json`'s
 *      `specialists?: SpecialistDefinition[]` block). Operators register
 *      additional specialists by reusing one of the built-in adapter
 *      ids. Adding adapter CODE is a PR-reviewed change; declaring a
 *      new specialist that uses an existing adapter is config-only.
 *
 * Lookup is case-insensitive on `id`. Duplicates from config override
 * the built-in seed (matching the agent registry's policy in
 * `src/orchestrator/agents/registry.ts`).
 *
 * Pure data + a thin lookup API. No I/O, no LLM, no clock.
 */

import { BUILTIN_ADAPTERS } from './adapters/index.ts';
import type { SpecialistAdapter, SpecialistDefinition, SpecialistId } from './types.ts';
import { SpecialistDefinitionSchema } from './types.ts';

/**
 * Built-in seed catalogue. Mirrors the plan file's "v1" specialists
 * table. Each entry pairs a stable id with one of the adapters in
 * `./adapters/index.ts`.
 *
 * Sora 2 is intentionally NOT in the seed list — OpenAI announced
 * sunset (web/app April 2026, API September 2026). Adding it now would
 * just create a deprecation cleanup task in 6 months.
 */
// Declared as a typed array first so the contextual SpecialistDefinition
// type propagates into each entry's literal — avoids `as const` widening
// conflicts when Object.freeze captures the array.
const SEED_DEFINITIONS: SpecialistDefinition[] = [
  {
    id: 'manual-edit-spec',
    displayName: 'Manual edit (CapCut / Premiere / DaVinci or human editor)',
    medium: 'edit-spec',
    grammar: 'edit-script',
    adapterId: 'manual-edit-spec',
    description:
      'Default for video / marketing creative. Outputs a shot-by-shot edit script the user (or their editor) cuts in CapCut / Premiere / DaVinci. TikTok 2026 algorithm rewards human-cut over raw-AI clips.',
    builtin: true,
  },
  {
    id: 'runway-gen-4.5',
    displayName: 'Runway Gen-4.5',
    medium: 'video',
    grammar: 'prose-medium',
    adapterId: 'runway-gen-4.5',
    description:
      'Best all-rounder text-to-video / image-to-video generator (May 2026). Use when handing the prompt directly to a generative video model.',
    defaultParameters: {
      aspectRatio: '9:16',
      durationSec: 10,
      motionScore: 5,
    },
    builtin: true,
  },
  {
    id: 'suno-v5',
    displayName: 'Suno v5',
    medium: 'audio',
    grammar: 'lyric-blocks',
    adapterId: 'suno-v5',
    description:
      'Suno v5 — full-song lyric + style mode. Outputs `[Verse] / [Chorus]` blocks with genre/era/tempo tags weighted at the start of the prompt.',
    defaultParameters: {
      bpm: 100,
      mode: 'lyric',
    },
    builtin: true,
  },
  {
    id: 'midjourney-v7',
    displayName: 'Midjourney v7',
    medium: 'image',
    grammar: 'subject-style-flags',
    adapterId: 'midjourney-v7',
    description:
      'Midjourney v7 — concise subject + style + flags. Best for editorial illustration, brand assets, mood boards.',
    defaultParameters: {
      aspectRatio: '1:1',
      styleStrength: 250,
      version: 7,
      styleRaw: false,
    },
    builtin: true,
  },
];

export const BUILTIN_SPECIALISTS: ReadonlyArray<SpecialistDefinition> = Object.freeze(SEED_DEFINITIONS);

/**
 * Read-only registry interface. Keeps the public surface narrow so
 * future implementations (e.g. a Phase E hot-reload registry) can swap
 * the impl without touching consumers.
 */
export interface SpecialistRegistry {
  /** Look up a specialist by id (case-insensitive). Returns null on miss. */
  get(id: SpecialistId): SpecialistDefinition | null;
  /** Resolve an adapter for a specialist id. Returns null on miss. */
  getAdapter(id: SpecialistId): SpecialistAdapter | null;
  /** All registered specialists (built-in seeds first, then config). */
  list(): ReadonlyArray<SpecialistDefinition>;
  /** Declared media supported by the registry — useful for clarification. */
  listMedia(): ReadonlyArray<SpecialistDefinition['medium']>;
}

/**
 * Build a SpecialistRegistry from optional config-supplied entries.
 * Built-in seeds are always registered. Config entries are validated
 * against `SpecialistDefinitionSchema`; entries with adapter ids that
 * do not resolve to a known adapter are dropped with a console.warn so
 * the system never silently registers a specialist that cannot format
 * a prompt.
 */
export function createSpecialistRegistry(
  configEntries?: ReadonlyArray<unknown>,
  adapters: Record<string, SpecialistAdapter> = BUILTIN_ADAPTERS,
): SpecialistRegistry {
  const byId = new Map<string, SpecialistDefinition>();

  for (const seed of BUILTIN_SPECIALISTS) {
    byId.set(seed.id.toLowerCase(), { ...seed, builtin: true });
  }

  if (Array.isArray(configEntries)) {
    for (const raw of configEntries) {
      const parsed = SpecialistDefinitionSchema.safeParse(raw);
      if (!parsed.success) {
        console.warn(
          '[vinyan] specialist registry: dropping invalid config entry —',
          parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        );
        continue;
      }
      const def = parsed.data;
      if (!adapters[def.adapterId]) {
        console.warn(
          `[vinyan] specialist registry: '${def.id}' references unknown adapterId='${def.adapterId}' — skipping. Known adapter ids: ${Object.keys(adapters).join(', ')}`,
        );
        continue;
      }
      byId.set(def.id.toLowerCase(), { ...def, builtin: false });
    }
  }

  return {
    get(id) {
      return byId.get(id.toLowerCase()) ?? null;
    },
    getAdapter(id) {
      const def = byId.get(id.toLowerCase());
      if (!def) return null;
      return adapters[def.adapterId] ?? null;
    },
    list() {
      return [...byId.values()];
    },
    listMedia() {
      const media = new Set<SpecialistDefinition['medium']>();
      for (const def of byId.values()) media.add(def.medium);
      return [...media];
    },
  };
}
