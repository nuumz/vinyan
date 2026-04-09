/**
 * Economic Consensus — deterministic rules for cross-instance economic disputes.
 *
 * 4-rule priority chain (A3: deterministic, no LLM):
 * 1. Both 'billing' tier → trust lower value (conservative)
 * 2. Mixed tiers → trust 'billing' over 'estimated'
 * 3. Same tier, peer trust < 'established' → trust local
 * 4. Same tier, peer trust >= 'established' → split difference
 *
 * Source of truth: Economy OS plan §E4
 */

export interface CostClaim {
  usd: number;
  tier: 'billing' | 'estimated';
}

export type PeerTrust = 'untrusted' | 'provisional' | 'established' | 'trusted';

export interface DisputeResolution {
  disputeId: string;
  type: 'cost_mismatch' | 'budget_violation' | 'pricing_disagreement';
  resolution: 'accept_local' | 'accept_remote' | 'split_difference';
  resolved_usd: number;
  deterministic_rule: string;
}

/**
 * Resolve an economic dispute between local and remote cost claims.
 * Pure function: same inputs → same output (A3).
 */
export function resolveEconomicDispute(
  disputeId: string,
  type: DisputeResolution['type'],
  localClaim: CostClaim,
  remoteClaim: CostClaim,
  peerTrustLevel: PeerTrust,
): DisputeResolution {
  // Rule 1: Both billing → trust lower value (conservative)
  if (localClaim.tier === 'billing' && remoteClaim.tier === 'billing') {
    const lowerUsd = Math.min(localClaim.usd, remoteClaim.usd);
    const resolution = localClaim.usd <= remoteClaim.usd ? 'accept_local' : 'accept_remote';
    return {
      disputeId,
      type,
      resolution: resolution as DisputeResolution['resolution'],
      resolved_usd: lowerUsd,
      deterministic_rule: 'R1: both billing, trust lower value',
    };
  }

  // Rule 2: Mixed tiers → trust billing over estimated
  if (localClaim.tier !== remoteClaim.tier) {
    if (localClaim.tier === 'billing') {
      return {
        disputeId,
        type,
        resolution: 'accept_local',
        resolved_usd: localClaim.usd,
        deterministic_rule: 'R2: local billing vs remote estimated, trust billing',
      };
    }
    return {
      disputeId,
      type,
      resolution: 'accept_remote',
      resolved_usd: remoteClaim.usd,
      deterministic_rule: 'R2: remote billing vs local estimated, trust billing',
    };
  }

  // Rule 3: Same tier, low trust → trust local
  if (peerTrustLevel === 'untrusted' || peerTrustLevel === 'provisional') {
    return {
      disputeId,
      type,
      resolution: 'accept_local',
      resolved_usd: localClaim.usd,
      deterministic_rule: `R3: same tier (${localClaim.tier}), peer trust ${peerTrustLevel}, trust local`,
    };
  }

  // Rule 4: Same tier, established+ trust → split difference
  const splitUsd = (localClaim.usd + remoteClaim.usd) / 2;
  return {
    disputeId,
    type,
    resolution: 'split_difference',
    resolved_usd: splitUsd,
    deterministic_rule: `R4: same tier (${localClaim.tier}), peer trust ${peerTrustLevel}, split difference`,
  };
}
