/**
 * Adapter dispatch — maps a specialist's `adapterId` (declared on its
 * `SpecialistDefinition`) to the concrete adapter function.
 *
 * This file is the single place new built-in adapters get wired. Adding
 * a Veo 3.1 / Pika / Kling / Flux adapter = one entry here + one new
 * file under `./*.ts`. Config-supplied specialists in `vinyan.json`
 * MUST reuse one of these adapter ids — config never injects code.
 */

import type { SpecialistAdapter } from '../types.ts';
import { manualEditSpecAdapter } from './manual-edit-spec.ts';
import { midjourneyV7Adapter } from './midjourney-v7.ts';
import { runwayGen4Adapter } from './runway-gen4.ts';
import { sunoV5Adapter } from './suno-v5.ts';

/**
 * Built-in adapter registry. Frozen so accidental reassignment in tests
 * (e.g. mocking) crashes loudly rather than silently leaking state.
 */
export const BUILTIN_ADAPTERS: Readonly<Record<string, SpecialistAdapter>> = Object.freeze({
  'manual-edit-spec': manualEditSpecAdapter,
  'runway-gen-4.5': runwayGen4Adapter,
  'suno-v5': sunoV5Adapter,
  'midjourney-v7': midjourneyV7Adapter,
});

export type BuiltinAdapterId = keyof typeof BUILTIN_ADAPTERS;
