/**
 * Yinyan T3 — Cross-family A1 enforcement helper.
 *
 * The critic-augmented verification path is only meaningful under A1
 * (Epistemic Separation) when the active critic provider is from a
 * DIFFERENT vendor family than the active generator. Same family means
 * the critic shares the generator's training-data biases and is therefore
 * statistically likely to repeat (rather than catch) failure modes.
 *
 * This module ships a single inference function + a soft enforcement
 * helper. Both are pure, deterministic (A3) and emit no LLM calls.
 *
 * Per the implementation plan: PR #47 lands enforcement as
 * `console.warn` + `governance-provenance` audit entry. Promotion to
 * a hard throw is a follow-up after one week of provenance observation
 * — that gives operators time to declare `family` on legacy provider
 * implementations before any startup begins to fail.
 */

import type { ProviderFamily } from '../llm/provider-format.ts';
import type { LLMProvider } from '../types.ts';

/**
 * Resolve the effective provider family. Prefers the explicit
 * `provider.family` field; falls back to a deterministic id-based
 * inference for legacy providers that haven't declared one.
 *
 * The id-based fallback recognizes the two families currently shipped
 * with Vinyan (Anthropic and OpenAI-compatible — see
 * `provider-format.ts`). Any other id pattern resolves to
 * `'openai-compat'` because that's the message-format-default in
 * `provider-format.ts:formatMessages` and matches OpenRouter's wire
 * shape for the long tail of third-party providers.
 */
export function inferProviderFamily(provider: LLMProvider): ProviderFamily {
  if (provider.family) return provider.family;
  const id = provider.id.toLowerCase();
  if (id.startsWith('anthropic') || id.includes('/anthropic/') || id.includes('claude')) {
    return 'anthropic';
  }
  return 'openai-compat';
}

/**
 * Outcome of a cross-family check. `kind: 'ok'` means the providers
 * differ; `kind: 'warn'` means the families match (A1 violation under
 * the soft enforcement policy).
 */
export type CrossFamilyOutcome =
  | { kind: 'ok'; generatorFamily: ProviderFamily; criticFamily: ProviderFamily }
  | { kind: 'warn'; generatorFamily: ProviderFamily; criticFamily: ProviderFamily; message: string };

/**
 * Compare generator + critic provider families. PURE function — does NOT
 * emit warnings or audit entries itself; the caller decides how to handle
 * the outcome. The factory wires this to `console.warn` + governance
 * provenance; tests assert the outcome shape directly.
 */
export function checkCrossFamily(generator: LLMProvider, critic: LLMProvider): CrossFamilyOutcome {
  const generatorFamily = inferProviderFamily(generator);
  const criticFamily = inferProviderFamily(critic);
  if (generatorFamily !== criticFamily) {
    return { kind: 'ok', generatorFamily, criticFamily };
  }
  return {
    kind: 'warn',
    generatorFamily,
    criticFamily,
    message:
      `A1 cross-family check: critic provider '${critic.id}' shares family '${criticFamily}' ` +
      `with generator '${generator.id}'. Critic is statistically likely to repeat the ` +
      `generator's failure modes. Configure a different-family provider for the critic ` +
      `to satisfy A1 (Epistemic Separation).`,
  };
}
