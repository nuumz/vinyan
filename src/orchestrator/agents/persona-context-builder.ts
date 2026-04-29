/**
 * Persona context builder — Phase-4 wiring activation.
 *
 * Composes a `PersonaBidContext` from a registry's `getDerivedCapabilities`
 * for a given persona id. This is the single point of truth that translates
 * "I'm dispatching this task to persona X" into the bid-time fields the
 * Phase-3 auction expects: persona id, loaded skill ids, declared capability
 * ids, content fingerprint, prompt-overhead estimate, plus the task's
 * required-capability list.
 *
 * Design notes:
 *   - A4: `skillFingerprint` is sha256 of *sorted* skill ids so the same
 *     loadout always produces the same fingerprint regardless of bind order.
 *   - A8: the function is pure; given the same registry state and arguments
 *     it returns the same context, so auction outcomes are replayable.
 *   - A9: returns null when there is no agent id, no derivation, or no
 *     loaded skills to advertise. Callers fall back to legacy provider-only
 *     bidding without a separate flag.
 */
import { createHash } from 'node:crypto';
import type { PersonaBidContext } from '../engine-selector.ts';
import type { CapabilityRequirement, SkillRef } from '../types.ts';
import { renderSkillCard, type SkillCardView, toSkillCardView } from './derive-persona-capabilities.ts';
import type { AgentRegistry } from './registry.ts';

/**
 * Approximate-tokens-per-character used to estimate skill-card prompt
 * overhead from rendered byte length. Conservative: matches the orchestrator's
 * existing 4-char≈1-token heuristic (`agent-worker-entry.ts` doc comment).
 */
const CHARS_PER_TOKEN = 4;

/**
 * Build a `PersonaBidContext` for the auction. Returns null when the persona
 * has no skills loaded — bidding falls back to provider-only behaviour.
 *
 * `requiredCapabilities` is forwarded verbatim so the auction's `skillMatch`
 * factor can attenuate bids by coverage. Pass through the same list the
 * intent resolver / capability analyzer produced for routing.
 */
export function buildPersonaBidContext(
  registry: Pick<AgentRegistry, 'getDerivedCapabilities'>,
  agentId: string | undefined,
  requiredCapabilities?: ReadonlyArray<CapabilityRequirement>,
): PersonaBidContext | null {
  if (!agentId) return null;
  const derived = registry.getDerivedCapabilities(agentId);
  if (!derived) return null;

  const loadedSkillIds = derived.loadedSkills.map((s) => s.frontmatter.id);
  if (loadedSkillIds.length === 0) {
    // No skill loadout to advertise — Phase-3 skillMatch defaults to 1.0 and
    // the persona-aware path adds no signal over legacy behaviour.
    return null;
  }

  // Capability ids actually advertised by the persona (raw + skill-derived).
  // `derived.capabilities` already includes both, with dedupe-by-last semantics
  // from `derivePersonaCapabilities`.
  const declaredCapabilityIds = derived.capabilities.map((c) => c.id);

  return {
    personaId: agentId,
    loadedSkillIds,
    declaredCapabilityIds,
    skillFingerprint: computeSkillFingerprint(loadedSkillIds),
    skillTokenOverhead: estimateSkillTokenOverhead(derived.loadedSkills.map(toSkillCardView)),
    requiredCapabilities: requiredCapabilities?.map((r) => ({ id: r.id, weight: r.weight })),
  };
}

/**
 * Compute the fingerprint that the auction stamps onto every bid carrying
 * this loadout (`EngineBid.skillFingerprint`). Sorting first guarantees
 * order-independence — the same skill set always yields the same hash.
 */
export function computeSkillFingerprint(skillIds: readonly string[]): string {
  if (skillIds.length === 0) return 'sha256:empty';
  const sorted = [...skillIds].sort((a, b) => a.localeCompare(b));
  const digest = createHash('sha256').update(sorted.join('\n')).digest('hex');
  return `sha256:${digest}`;
}

/**
 * Estimate the prompt-token overhead the persona's skill cards add to the
 * system prompt. Used by the Vickrey budget cap so a skill-loaded winner
 * isn't starved by a legacy second-place bid that loaded nothing
 * (risk L4 mitigation).
 *
 * Skips cards that exceed `MAX_SKILL_CARD_CHARS` (the prompt section drops
 * them too) so the estimate matches the actual rendered prompt.
 */
export function estimateSkillTokenOverhead(cards: readonly SkillCardView[]): number {
  let total = 0;
  for (const card of cards) {
    const rendered = renderSkillCard(card);
    if (!rendered) continue;
    total += Math.ceil(rendered.length / CHARS_PER_TOKEN);
  }
  return total;
}
