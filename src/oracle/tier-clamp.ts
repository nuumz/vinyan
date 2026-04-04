/**
 * ECP Confidence Clamping — ECP spec §4.4, A5 (Tiered Trust).
 *
 * Confidence is clamped by up to three independent ceilings:
 * 1. Trust tier (intrinsic to the engine): deterministic=1.0, heuristic=0.9, probabilistic=0.7, speculative=0.4
 * 2. Transport layer (extrinsic): stdio=1.0, websocket=0.95, http=0.7, a2a=0.7
 * 3. Peer trust (A2A only): untrusted=0.25, provisional=0.40, established=0.50, trusted=0.60
 *
 * Applied at verdict intake — before aggregation or storage.
 *
 * Source of truth: spec/ecp-spec.md §4.4, architecture/protocol-architecture.md §3/§6
 */
import type { SubjectiveOpinion } from '../core/subjective-opinion.ts';
import { clampOpinionByTier, projectedProbability, SL_EPSILON } from '../core/subjective-opinion.ts';

/** ECP spec §4.4: Confidence caps by trust tier. */
const TIER_CAPS: Record<string, number> = {
  deterministic: 1.0,
  heuristic: 0.9,
  probabilistic: 0.7,
  speculative: 0.4,
};

/** Protocol Architecture §3: Transport-level trust degradation. */
const TRANSPORT_CAPS: Record<string, number> = {
  stdio: 1.0,
  websocket: 0.95,
  http: 0.7,
  a2a: 0.7,
};

/** Peer trust caps — empirical (Wilson LB), NOT declared. Even trusted remote caps at 0.60. */
export const PEER_TRUST_CAPS = {
  untrusted: 0.25,
  provisional: 0.4,
  established: 0.5,
  trusted: 0.6,
} as const;

export type PeerTrustLevel = keyof typeof PEER_TRUST_CAPS;

/** Clamp confidence by tier ceiling (A5: Tiered Trust). */
export function clampByTier(confidence: number, tier?: string): number {
  if (!tier) return confidence;
  const cap = TIER_CAPS[tier] ?? TIER_CAPS['heuristic']!;  // Unknown tier → heuristic default (0.9)
  return Math.min(confidence, cap);
}

/** Apply transport-level trust degradation (Protocol Architecture §3). */
export function clampByTransport(confidence: number, transport?: string): number {
  if (!transport || transport === 'stdio') return confidence;
  const cap = TRANSPORT_CAPS[transport] ?? 1.0;
  return Math.min(confidence, cap);
}

/** Apply peer trust cap (A2A only — Wilson LB progression). */
export function clampByPeerTrust(confidence: number, peerTrust?: PeerTrustLevel): number {
  if (!peerTrust) return confidence;
  const cap = PEER_TRUST_CAPS[peerTrust];
  return Math.min(confidence, cap);
}

/** Clamp by tier with A2A safety: untiered A2A verdicts default to 'speculative' (0.4). */
export function clampByTierWithOrigin(
  confidence: number,
  tier?: string,
  origin?: 'local' | 'a2a' | 'mcp',
): number {
  if (origin === 'a2a' && !tier) {
    return Math.min(confidence, TIER_CAPS['speculative']!);  // 0.4
  }
  return clampByTier(confidence, tier);
}

/**
 * Full ECP confidence adjustment: tier × transport × peer trust.
 * Takes the minimum across all applicable ceilings.
 */
export function clampFull(confidence: number, tier?: string, transport?: string, peerTrust?: PeerTrustLevel): number {
  return clampByPeerTrust(clampByTransport(clampByTier(confidence, tier), transport), peerTrust);
}

// ── SL Opinion Clamping (ECP v2) ────────────────────────────────────────

/**
 * Scale down belief so that projectedProbability ≤ ceiling,
 * redistributing excess mass to uncertainty (preserving disbelief).
 * Preserves the SL invariant b + d + u = 1.
 *
 * The delta accounts for baseRate feedback: moving mass to uncertainty
 * feeds back through P = b + u×a, so raw `excess` under-corrects.
 * delta = excess / (1 - baseRate) compensates for the baseRate×Δu term.
 */
function scaleBeliefByCeiling(
  opinion: SubjectiveOpinion,
  ceiling: number,
): SubjectiveOpinion {
  const projected = projectedProbability(opinion);
  if (projected <= ceiling) return opinion;

  const excess = projected - ceiling;
  const divisor = 1 - opinion.baseRate;
  const delta = divisor > SL_EPSILON ? excess / divisor : excess;  // guard: baseRate ≈ 1.0
  const newBelief = Math.max(0, opinion.belief - delta);
  return {
    belief: newBelief,
    disbelief: opinion.disbelief,
    uncertainty: 1 - newBelief - opinion.disbelief,
    baseRate: opinion.baseRate,
  };
}

/**
 * Clamp an SL opinion tuple by tier, transport, and peer trust.
 *
 * Unlike scalar clamping (which caps the maximum confidence),
 * opinion clamping enforces MINIMUM UNCERTAINTY FLOORS per tier.
 * A deterministic oracle can have u ≥ 0.01, a heuristic oracle u ≥ 0.10, etc.
 *
 * This preserves the SL invariant (b + d + u = 1) by redistributing
 * mass from belief/disbelief into uncertainty.
 *
 * Axiom A5: tiered trust → tiered uncertainty floors.
 */
export function clampOpinionFull(
  opinion: SubjectiveOpinion,
  tier?: string,
  transport?: string,
  peerTrust?: PeerTrustLevel,
): SubjectiveOpinion {
  // Guard: normalize invalid input opinions (from external sources)
  const sum = opinion.belief + opinion.disbelief + opinion.uncertainty;
  if (Math.abs(sum - 1.0) > SL_EPSILON) {
    opinion = {
      ...opinion,
      belief: opinion.belief / sum,
      disbelief: opinion.disbelief / sum,
      uncertainty: opinion.uncertainty / sum,
    };
  }

  const effectiveTier = tier ?? 'heuristic';

  // Step 1: Apply tier uncertainty floor
  let clamped = clampOpinionByTier(opinion, effectiveTier);

  // Step 2: Apply transport-based ceiling by scaling down belief proportionally
  const transportCap = TRANSPORT_CAPS[transport ?? 'stdio'] ?? 1.0;
  clamped = scaleBeliefByCeiling(clamped, transportCap);
  // Re-apply tier floor — scaling may have shifted uncertainty below minimum
  clamped = clampOpinionByTier(clamped, effectiveTier);

  // Step 3: Apply peer trust ceiling (same proportional scaling)
  if (peerTrust) {
    const peerCap = PEER_TRUST_CAPS[peerTrust];
    clamped = scaleBeliefByCeiling(clamped, peerCap);
    clamped = clampOpinionByTier(clamped, effectiveTier);
  }

  return clamped;
}
