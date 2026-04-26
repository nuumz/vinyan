/**
 * Per-phase LLM config resolver (G3 — interior LLM control).
 *
 * Each Vinyan phase (perceive / comprehend / brainstorm / generate / verify /
 * critic / …) calls `resolvePhaseConfig(phase, routing, defaults)` to merge:
 *
 *   1. The phase's hardcoded defaults (current behavior — bit-exact when no
 *      override is supplied).
 *   2. The routing-level overrides carried in `RoutingDecision.phaseConfigs`,
 *      populated by the risk router from `vinyan.json` orchestrator config.
 *
 * The resolver returns a partial `LLMRequest` shape suitable for spreading
 * into `provider.generate(...)`. Fields the caller cares about (systemPrompt,
 * userPrompt, maxTokens, tools, messages, thinking, tiers) stay outside the
 * resolver — the caller is the source of truth for prompt content.
 *
 * Why this separation: A1 epistemic separation depends on the Critic running
 * at T=0 and the Brainstorm running at T=0.7. Currently every phase
 * hardcodes its temperature; making them config-driven lets the orchestrator
 * align sampling with role without phases mutating each other's choices.
 *
 * Axioms: A1 (Epistemic Separation — phase role determines sampling profile),
 * A3 (Deterministic Governance — overrides flow through declared config, not
 * runtime guesswork).
 */

import type { LLMRequest, PhaseLLMConfig, PhaseName, RoutingDecision } from '../types.ts';

/**
 * Subset of `LLMRequest` fields the resolver controls. Keep narrow so the
 * resolver never accidentally clobbers prompt or tool fields.
 */
export type ResolvedSamplingParams = Pick<LLMRequest, 'temperature' | 'topP' | 'topK' | 'stopSequences'>;

export interface ResolvedPhaseConfig {
  /** Optional model override (caller decides whether to honor it). */
  model?: string;
  /** Sampling params with defaults applied. Spread directly into LLMRequest. */
  sampling: ResolvedSamplingParams;
  /** Effort hint for extended-thinking modes; undefined when phase didn't ask. */
  reasoningEffort?: PhaseLLMConfig['reasoningEffort'];
}

/**
 * Defaults a phase declares as its baseline behaviour. Pass only the fields
 * the phase actually has an opinion on; the rest stay undefined and the
 * provider falls back to its own SDK defaults.
 */
export type PhaseDefaults = Partial<ResolvedSamplingParams> & {
  reasoningEffort?: PhaseLLMConfig['reasoningEffort'];
};

/**
 * Merge a phase's hardcoded defaults with the routing-level override map.
 *
 * Precedence (highest wins):
 *   1. routing.phaseConfigs[phase].<field>
 *   2. defaults.<field>
 *
 * `undefined` in the override is treated as "no opinion" — the default still
 * applies. Empty `stopSequences: []` is also treated as unset so an override
 * of `[]` doesn't accidentally clear a default like `['\n\n']`.
 */
export function resolvePhaseConfig(
  phase: PhaseName,
  routing: Pick<RoutingDecision, 'phaseConfigs'> | undefined,
  defaults: PhaseDefaults = {},
): ResolvedPhaseConfig {
  const override: PhaseLLMConfig | undefined = routing?.phaseConfigs?.[phase];

  const sampling: ResolvedSamplingParams = {};
  const merged = mergeWithOverride(defaults, override);
  if (merged.temperature !== undefined) sampling.temperature = merged.temperature;
  if (merged.topP !== undefined) sampling.topP = merged.topP;
  if (merged.topK !== undefined) sampling.topK = merged.topK;
  if (merged.stopSequences && merged.stopSequences.length > 0) {
    sampling.stopSequences = merged.stopSequences;
  }

  const result: ResolvedPhaseConfig = { sampling };
  if (override?.model) result.model = override.model;
  const effort = override?.reasoningEffort ?? defaults.reasoningEffort;
  if (effort) result.reasoningEffort = effort;
  return result;
}

interface MergedFields {
  temperature?: number;
  topP?: number;
  topK?: number;
  stopSequences?: string[];
}

function mergeWithOverride(defaults: PhaseDefaults, override: PhaseLLMConfig | undefined): MergedFields {
  // Empty `stopSequences: []` from override → treat as "no opinion" so a
  // default like `['\n\n']` still applies. Forcing-clear isn't a use case.
  const overrideStops =
    override?.stopSequences && override.stopSequences.length > 0 ? override.stopSequences : undefined;
  return {
    temperature: pick(override?.temperature, defaults.temperature),
    topP: pick(override?.topP, defaults.topP),
    topK: pick(override?.topK, defaults.topK),
    stopSequences: pick(overrideStops, defaults.stopSequences),
  };
}

function pick<T>(override: T | undefined, fallback: T | undefined): T | undefined {
  return override !== undefined ? override : fallback;
}
