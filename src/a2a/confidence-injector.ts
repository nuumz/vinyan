/**
 * A2A Confidence Injector — I13 compliance.
 *
 * A5 (Tiered Trust): Remote A2A results use the canonical clamping pipeline
 * (tier × transport × peer trust) instead of hardcoded caps.
 * Type is forced to "uncertain" — remote engines never claim "known".
 */
import type { OracleVerdict } from "../core/types.ts";
import { clampFull, type PeerTrustLevel } from "../oracle/tier-clamp.ts";

/**
 * Cap an existing OracleVerdict's confidence for A2A context.
 * Uses clampFull() with transport="a2a" and the peer's empirical trust level.
 * Type forced to "uncertain" (A5: remote = lowest trust tier).
 */
export function injectA2AConfidence(
  verdict: OracleVerdict,
  tier?: string,
  peerTrust: PeerTrustLevel = "untrusted",
): OracleVerdict {
  return {
    ...verdict,
    confidence: clampFull(verdict.confidence, tier, "a2a", peerTrust),
    type: "uncertain",
  };
}

/**
 * Create a new OracleVerdict from an A2A task result.
 * Clamped by peer trust level, type "uncertain".
 */
export function createA2AVerdict(
  success: boolean,
  reason: string,
  peerTrust: PeerTrustLevel = "untrusted",
): OracleVerdict {
  return {
    verified: success,
    type: "uncertain",
    confidence: clampFull(1.0, undefined, "a2a", peerTrust),
    evidence: [],
    fileHashes: {},
    reason,
    duration_ms: 0,
  };
}
