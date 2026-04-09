/**
 * ThinkingPolicy → Provider-specific parameter translator.
 *
 * Maps the abstract ThinkingPolicy into concrete provider params.
 * Anthropic: delegates to existing buildThinkingParams().
 * OpenAI: maps to reasoning_effort.
 * Generic: maps to effort_level.
 *
 * Source of truth: docs/design/extensible-thinking-system-design.md §4.2
 */
import type { ThinkingConfig } from '../types.ts';
import type { ThinkingPolicy } from '../thinking/thinking-policy.ts';

export interface ProviderThinkingParams {
  /** Provider-specific thinking configuration (pass-through to API). */
  thinkingConfig: ThinkingConfig;
  /** Max tokens allocated to thinking (ceiling from policy). */
  thinkingBudget?: number;
}

/**
 * Translate a ThinkingPolicy into provider-specific params.
 * When ceiling is set, clamps the budget accordingly.
 *
 * NOTE: Phase 2.2+ will wire this into the worker dispatch path
 * to apply provider-specific thinking params (Anthropic thinking mode,
 * OpenAI reasoning_effort). Currently the worker pool uses
 * routing.thinkingConfig directly.
 */
export function translatePolicyToProvider(
  policy: ThinkingPolicy,
): ProviderThinkingParams {
  const ceiling = policy.thinkingCeiling;

  if (policy.thinking.type === 'disabled') {
    return { thinkingConfig: { type: 'disabled' } };
  }

  // Apply ceiling as explicit budget when available
  if (ceiling !== undefined && ceiling > 0 && policy.thinking.type === 'adaptive') {
    // Convert adaptive to explicit budget when ceiling constrains it
    return {
      thinkingConfig: { type: 'enabled', budgetTokens: ceiling },
      thinkingBudget: ceiling,
    };
  }

  if (policy.thinking.type === 'enabled' && ceiling !== undefined && ceiling > 0) {
    // Clamp existing budget to ceiling
    const clamped = Math.min(policy.thinking.budgetTokens, ceiling);
    return {
      thinkingConfig: { type: 'enabled', budgetTokens: clamped },
      thinkingBudget: clamped,
    };
  }

  // Pass through without ceiling modification
  return {
    thinkingConfig: policy.thinking,
    thinkingBudget: ceiling ?? undefined,
  };
}
