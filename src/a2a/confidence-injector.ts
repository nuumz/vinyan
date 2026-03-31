/**
 * A2A Confidence Injector — I13 compliance.
 *
 * A5 (Tiered Trust): Remote A2A results are always "probabilistic" tier,
 * which maps to OracleVerdict type "uncertain" (lowest-confidence epistemic state).
 * Confidence is capped at 0.5 — remote engines never outrank local oracles.
 */
import type { OracleVerdict } from "../core/types.ts";

/** I13: Remote verdict confidence ceiling — A2A results never exceed 0.5 */
export const A2A_CONFIDENCE_CAP = 0.5;

/**
 * Cap an existing OracleVerdict's confidence for A2A context.
 * - Confidence clamped to A2A_CONFIDENCE_CAP
 * - Type forced to "uncertain" (A5: remote = lowest trust tier)
 * - All other fields (evidence, fileHashes, etc.) preserved as-is
 */
export function injectA2AConfidence(verdict: OracleVerdict): OracleVerdict {
  return {
    ...verdict,
    confidence: Math.min(verdict.confidence, A2A_CONFIDENCE_CAP),
    type: "uncertain", // A5: remote = lowest trust tier
  };
}

/**
 * Create a new OracleVerdict from an A2A task result.
 * Always capped at 0.5, type "uncertain".
 */
export function createA2AVerdict(success: boolean, reason: string): OracleVerdict {
  return {
    verified: success,
    type: "uncertain",
    confidence: A2A_CONFIDENCE_CAP,
    evidence: [],
    fileHashes: {},
    reason,
    duration_ms: 0,
  };
}
