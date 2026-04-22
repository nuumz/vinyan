/**
 * Skills Hub promotion rules — pure, deterministic, no-LLM-in-the-loop.
 *
 * Axiom anchor: A3 Deterministic Governance. The importer's final
 * `promote | reject | quarantine-continue` decision is a pure function of
 * structured evidence produced by upstream verifiers (static-scan,
 * Oracle Gate, Critic). Any appeal to an LLM here would violate A3.
 *
 * Rule id is embedded in the decision so the ledger can replay exactly
 * which policy version fired.
 */
import type { ConfidenceTier } from '../../core/confidence-tier.ts';

export interface StaticScanResult {
  readonly injectionFound: boolean;
  readonly bypassFound: boolean;
  readonly suspicious: readonly string[];
}

/**
 * Minimal fields the promotion rule reads from an `OracleGate` verdict.
 *
 * Accepts the full `GateVerdict` structurally — the rule only inspects
 * `decision` (mapped to an epistemic label) and the numeric aggregate
 * confidence. Wider gate internals are deliberately not consumed here.
 */
export interface GateVerdictLike {
  /**
   * Epistemic verdict. Mapped from the gate's `decision`/`epistemicDecision`
   * by the caller.
   */
  readonly decision: 'verified' | 'falsified' | 'uncertain' | 'unknown' | 'contradictory';
  /** Weighted aggregate oracle confidence, 0..1. */
  readonly aggregateConfidence: number;
}

export interface CriticResultLike {
  readonly approved: boolean;
  readonly confidence: number;
  readonly notes: string;
}

export interface PromotionInputs {
  readonly staticScan: StaticScanResult;
  readonly gateVerdict: GateVerdictLike;
  readonly critic: CriticResultLike;
  readonly signatureVerified: boolean;
  readonly origin: 'local' | 'hub' | 'a2a' | 'mcp';
  readonly declaredTier: ConfidenceTier;
}

export interface PromotionDecision {
  readonly kind: 'promote' | 'reject' | 'quarantine-continue';
  readonly toTier?: ConfidenceTier;
  readonly reason: string;
  readonly ruleId: string;
}

export const HUB_IMPORT_RULE_ID = 'hub-import-v1';

/** Confidence floor for promotion. Below this → reject. */
export const HUB_IMPORT_GATE_CONFIDENCE_FLOOR = 0.7;

/**
 * Decide whether to promote, reject, or keep quarantining an imported skill.
 *
 * Order of checks matters (earlier rules short-circuit) so failure reasons
 * are deterministic and reproducible:
 *
 *   1. Static-scan hit    → reject (A6 Zero-Trust Execution)
 *   2. Gate falsified     → reject
 *   3. Critic rejected    → reject
 *   4. Gate unknown/contradictory → quarantine-continue (indeterminate)
 *   5. Confidence < floor → reject
 *   6. Gate verified + signed + hub origin → heuristic
 *   7. Gate verified (otherwise)          → probabilistic
 */
export function decidePromotion(inputs: PromotionInputs): PromotionDecision {
  const { staticScan, gateVerdict, critic, signatureVerified, origin } = inputs;

  if (staticScan.injectionFound || staticScan.bypassFound) {
    return {
      kind: 'reject',
      reason: 'static-scan',
      ruleId: HUB_IMPORT_RULE_ID,
    };
  }

  if (gateVerdict.decision === 'falsified') {
    return {
      kind: 'reject',
      reason: 'gate-falsified',
      ruleId: HUB_IMPORT_RULE_ID,
    };
  }

  if (!critic.approved) {
    return {
      kind: 'reject',
      reason: 'critic-rejected',
      ruleId: HUB_IMPORT_RULE_ID,
    };
  }

  if (gateVerdict.decision === 'unknown' || gateVerdict.decision === 'contradictory') {
    return {
      kind: 'quarantine-continue',
      reason: `gate-${gateVerdict.decision}`,
      ruleId: HUB_IMPORT_RULE_ID,
    };
  }

  if (gateVerdict.decision !== 'verified') {
    // Uncertain, or any other non-verified label → reject conservatively.
    return {
      kind: 'reject',
      reason: `gate-${gateVerdict.decision}`,
      ruleId: HUB_IMPORT_RULE_ID,
    };
  }

  if (gateVerdict.aggregateConfidence < HUB_IMPORT_GATE_CONFIDENCE_FLOOR) {
    return {
      kind: 'reject',
      reason: 'gate-low-confidence',
      ruleId: HUB_IMPORT_RULE_ID,
    };
  }

  const targetTier: ConfidenceTier = signatureVerified && origin === 'hub' ? 'heuristic' : 'probabilistic';

  return {
    kind: 'promote',
    toTier: targetTier,
    reason: 'ok',
    ruleId: HUB_IMPORT_RULE_ID,
  };
}
