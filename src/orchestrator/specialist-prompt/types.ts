/**
 * Specialist-prompt types — Phase A of the smart-creative-workflow refactor.
 *
 * A "specialist" is a downstream system that takes Vinyan's synthesised
 * creative artefact and produces the binary deliverable (video MP4, music
 * WAV, raster image, edited cut, etc.). Each specialist has its own prompt
 * grammar — Sora wants prose, Runway wants medium prose + camera control,
 * Suno wants `[Verse]/[Chorus]` blocks plus genre tags, Midjourney wants
 * subject + style + flags. A `SpecialistAdapter` formats Vinyan's output
 * for one specific specialist.
 *
 * Design constraints (cross-referenced with the plan file):
 *   - Adapter pattern only — NO `outputContract` enum on `IntentResolution`.
 *     Adapters are looked up by `specialistId` at format time.
 *   - Config-driven — registry entries can be supplemented from
 *     `vinyan.json`'s `specialists?: SpecialistDefinition[]` block. Models
 *     churn quarterly so hard-coding the catalogue is not viable.
 *   - The plan reserves `manual-edit-spec` as the default for video
 *     creative tasks (TikTok 2026 algorithm penalises raw-AI clips).
 *
 * No I/O in this module. The adapter implementation may NOT reach out to
 * an LLM or network — it's a pure transform from `WorkflowResult` shape +
 * `SpecialistDefinition` parameters into a string prompt.
 */

import { z } from 'zod';

/**
 * Stable identifier for a specialist. Lowercase ASCII slug shape so the
 * id is safe to embed in URLs, log lines, and Zod literal unions.
 *
 * Built-in seeds: `manual-edit-spec`, `runway-gen-4.5`, `suno-v5`,
 * `midjourney-v7`. Operators may register more via `vinyan.json`.
 */
export type SpecialistId = string;

/**
 * Output medium — selected by the adapter to help downstream UI / tests
 * decide how to render or compare two prompts (e.g. snapshot diffs ignore
 * structured-JSON whitespace differently from prose).
 */
export type SpecialistOutputMedium =
  | 'video' // raw video frames (Runway / Veo / Pika / Kling / Sora etc.)
  | 'audio' // music or sound (Suno / Udio / MusicGen)
  | 'image' // raster images (Midjourney / Flux / DALL-E / SD)
  | 'edit-spec' // human / NLE-driven edit (CapCut / Premiere / DaVinci, or manual)
  | 'multi'; // bundle (e.g. shot-script + music suggestion + thumbnail brief)

/**
 * Prompt grammar shape — informational tag the adapter declares so the
 * UI can hint to the user what kind of output to expect (prose vs JSON
 * vs structured tags). Not load-bearing for routing.
 */
export type SpecialistPromptGrammar =
  | 'prose-detailed' // long-form prose with visual + camera detail (Sora-class)
  | 'prose-medium' // medium prose, often with a few structured params (Runway)
  | 'prose-concise' // very short prose + flags (Pika, Midjourney)
  | 'lyric-blocks' // `[Verse] / [Chorus]` style + meta tags (Suno / Udio)
  | 'subject-style-flags' // `subject, style --ar 9:16 --v 6` (Midjourney / Flux)
  | 'json-spec' // strict JSON document (Runway API, custom workflows)
  | 'edit-script'; // shot list / NLE-friendly script (CapCut / human editor)

/**
 * The artefact Vinyan hands to the adapter. This is a structured snapshot
 * of the workflow result + the user's clarification answers. The adapter
 * uses whatever fields make sense and ignores the rest.
 *
 * `synthesisOutput` is the raw text Vinyan's collaboration / single-agent
 * pipeline produced. `clarification` carries the resolved answers from the
 * creative-clarification gate (genre, audience, tone, length, platform).
 * `goalSummary` is a one-line restatement of the user's original ask, used
 * by adapters that prepend a "What we're making" header.
 */
export interface SpecialistFormatRequest {
  goalSummary: string;
  /** The text artefact produced by Vinyan's pipeline. */
  synthesisOutput: string;
  /** Resolved clarification answers, when available. */
  clarification?: {
    genre?: string;
    audience?: string;
    tone?: string[];
    length?: string;
    platform?: string[];
    /** Free-text override the user typed instead of picking an option. */
    freeText?: Record<string, string>;
  };
  /**
   * Optional domain hint (matches the `CreativeDomain` taxonomy in
   * `clarification-templates.ts`). Adapters use this to bias defaults
   * — e.g. `manual-edit-spec` shows different scaffolding for `video`
   * vs `music` vs `visual`.
   */
  creativeDomain?:
    | 'webtoon'
    | 'novel'
    | 'article'
    | 'video'
    | 'music'
    | 'game'
    | 'marketing'
    | 'education'
    | 'business'
    | 'visual'
    | 'generic';
  /**
   * Free-form parameter map declared on the `SpecialistDefinition`. The
   * adapter may pluck adapter-specific knobs out (e.g. `aspectRatio`,
   * `motionScore`, `seed`, `negativePrompt`). Pure values — no callbacks.
   */
  parameters?: Record<string, string | number | boolean | undefined>;
}

/**
 * Adapter response — the formatted prompt plus the metadata the caller
 * needs to render or store it. `prompt` is the string the user copies /
 * sends to the specialist; `parameters` is the structured side-channel
 * (e.g. for an API caller that wants `aspect_ratio` as a separate field).
 */
export interface SpecialistFormatResponse {
  /** The text prompt or script the user feeds the specialist. */
  prompt: string;
  /** Optional structured parameters the specialist's API also accepts. */
  parameters?: Record<string, string | number | boolean>;
  /**
   * Short notes the user should read alongside the prompt — e.g.
   * "Run this in Suno's lyric mode, NOT instrumental mode." Up to a few
   * lines; do not duplicate prompt content.
   */
  notes?: string[];
}

/**
 * The transform a specialist defines. Pure, synchronous, no I/O. The
 * registry passes a `SpecialistFormatRequest` and gets back a
 * `SpecialistFormatResponse`. Implementations live under
 * `specialist-prompt/adapters/`.
 */
export type SpecialistAdapter = (req: SpecialistFormatRequest) => SpecialistFormatResponse;

/**
 * Registry entry — declarative description of one specialist. The same
 * shape is used by built-in seeds (declared in `registry.ts`) and by
 * config-supplied entries (validated by `SpecialistDefinitionSchema`).
 *
 * `adapterId` selects which adapter implementation handles the format
 * call. Built-in adapter ids match the well-known specialist ids
 * (`manual-edit-spec`, `runway-gen-4.5`, `suno-v5`, `midjourney-v7`).
 * Config-supplied entries reuse one of the built-in adapters by id —
 * we deliberately do NOT let config inject adapter code; that's a code
 * change that should land via PR review.
 */
export interface SpecialistDefinition {
  id: SpecialistId;
  /** Human-readable name shown in clarification UI and traces. */
  displayName: string;
  /** Output medium — video / audio / image / edit-spec / multi. */
  medium: SpecialistOutputMedium;
  /** Prompt grammar tag (informational). */
  grammar: SpecialistPromptGrammar;
  /** Which adapter implementation formats requests for this specialist. */
  adapterId: SpecialistId;
  /**
   * Short "when to pick this" description shown alongside the option in
   * the clarification gate. Keep under 120 chars.
   */
  description: string;
  /**
   * Free-form default parameters merged into `SpecialistFormatRequest.parameters`
   * when the user does not override. Adapters validate the keys they need.
   */
  defaultParameters?: Record<string, string | number | boolean>;
  /**
   * True for the seed entries that ship with Vinyan. Config entries are
   * registered with `builtin: false`. Used by the registry's `listAll()`
   * to surface "operator-added" specialists separately if a UI wants to.
   */
  builtin?: boolean;
}

/**
 * Zod validator for config-supplied `specialists?: SpecialistDefinition[]`
 * blocks. Used by `src/config/schema.ts` to validate the user's
 * `vinyan.json`. Mirrors the TypeScript interface.
 *
 * Constraints:
 *   - `id` is a kebab-case slug, 1-64 chars.
 *   - `adapterId` must match the same shape; the registry verifies it
 *     resolves to a known adapter at registration time.
 */
export const SpecialistDefinitionSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(
      /^[a-z][a-z0-9-]*\.?[a-z0-9-]*$/,
      'specialist id must be kebab-case (a-z, 0-9, -, optional dot for version)',
    ),
  displayName: z.string().min(1).max(120),
  medium: z.enum(['video', 'audio', 'image', 'edit-spec', 'multi']),
  grammar: z.enum([
    'prose-detailed',
    'prose-medium',
    'prose-concise',
    'lyric-blocks',
    'subject-style-flags',
    'json-spec',
    'edit-script',
  ]),
  adapterId: z.string().min(1).max(64),
  description: z.string().min(1).max(280),
  defaultParameters: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  builtin: z.boolean().optional(),
});

export type SpecialistDefinitionInput = z.infer<typeof SpecialistDefinitionSchema>;
