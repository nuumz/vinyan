/**
 * Built-in persona roster — shipped with Vinyan.
 *
 * Personas are role-pure archetypes of cognition. Domain specialization
 * (TypeScript, fiction, scheduling, etc.) lives in skill packs, not in the
 * persona itself. Users extend via `vinyan.json` agents[] or CLI; built-ins
 * can be overridden (same id in config replaces the default).
 *
 * Roster covers nine cognitive roles:
 *   - coordinator (route work)
 *   - developer / architect / author / researcher (Generator-class)
 *   - reviewer (Verifier-class)
 *   - assistant (reflex Q&A)
 *   - mentor (Guide-class — dialogue-based support)
 *   - concierge (personal logistics with ongoing memory)
 *
 * The Phase-1 redesign retired the prior domain-locked roster (ts-coder,
 * system-designer, secretary, writer, creative-director, plot-architect,
 * story-strategist, novelist, editor, critic) under a hard-cut migration —
 * see CHANGELOG and `docs/design/agent-redesign.md` for the rationale.
 */
import type { AgentSpec } from '../../types.ts';
import { architect } from './architect.ts';
import { assistant } from './assistant.ts';
import { author } from './author.ts';
import { concierge } from './concierge.ts';
import { coordinator } from './coordinator.ts';
import { developer } from './developer.ts';
import { mentor } from './mentor.ts';
import { researcher } from './researcher.ts';
import { reviewer } from './reviewer.ts';

export const BUILTIN_AGENTS: readonly AgentSpec[] = [
  coordinator,
  developer,
  architect,
  author,
  reviewer,
  assistant,
  researcher,
  mentor,
  concierge,
] as const;

/** Default persona for tasks with no explicit selection. */
export const DEFAULT_AGENT_ID = 'coordinator';

/**
 * Legacy ids retired by the Phase-1 redesign. Used by the registry to detect
 * stale config references and emit a one-time `agent:legacy-id` event so
 * users see the migration message immediately rather than silently falling
 * back to the default. There is intentionally no alias resolution — a hard
 * cut surfaces the migration cost up front.
 */
export const RETIRED_LEGACY_AGENT_IDS: readonly string[] = [
  'ts-coder',
  'system-designer',
  'secretary',
  'writer',
  'creative-director',
  'plot-architect',
  'story-strategist',
  'novelist',
  'editor',
  'critic',
] as const;

export { architect, assistant, author, concierge, coordinator, developer, mentor, researcher, reviewer };
