/**
 * Comprehension Oracle — rule-based verifier for ComprehendedTaskMessage.
 *
 * Axiom A1 enforcement: the comprehension engine PROPOSES; this oracle
 * DISPOSES. No field in the engine's output is trusted by downstream
 * governance (intent-resolver, gate, workflow) until it passes here.
 *
 * Design choices:
 *  - Rule-based only (A3). No LLM in the decision path.
 *  - Narrow verdict shape: we do not use the file-oriented `OracleVerdict`
 *    because comprehension is session-state-oriented, not content-hash-
 *    bound to a file. Synthesizing fake Evidence entries would violate A4.
 *    Instead we expose a purpose-fit `ComprehensionVerdict` that still
 *    carries the A2 type taxonomy and A5 tier.
 *  - &lt;50ms target: all checks are pure predicates over the envelope and
 *    its conversation snapshot; no IO.
 *
 * Accepts: well-formed envelope, non-fabricated referents, consistent tier.
 * Rejects: fabricated pending questions, resolvedGoal that doesn't trace
 *          to any session content when isClarificationAnswer=true.
 *
 * Graceful degradation: on reject, orchestrator falls back to the literal
 * goal — the pipeline never hard-fails because comprehension is advisory
 * for routing (the literal goal was already valid before this phase).
 */

import type {
  ComprehendedTaskMessage,
  ComprehensionEngineType,
} from '../../orchestrator/comprehension/types.ts';
import { maxTierForEngineType, tierRank } from '../../orchestrator/comprehension/types.ts';
import type { ConversationEntry } from '../../orchestrator/types.ts';

/**
 * Narrow verdict shape — compatible in spirit with OracleVerdict but does
 * not require file-bound Evidence. Events emitted on the bus SHOULD carry
 * this shape verbatim.
 */
export interface ComprehensionVerdict {
  verified: boolean;
  /** A2 taxonomy — orchestrator reads this for routing decisions. */
  type: 'known' | 'unknown' | 'uncertain' | 'contradictory';
  /** Oracle-assigned confidence (≤ engine's self-reported confidence). */
  confidence: number;
  /** A5: tier assigned to the VERIFIED message (not the engine's claim). */
  tier: 'deterministic' | 'heuristic' | 'probabilistic' | 'unknown';
  /** Reasons surfaced to logs + dashboards; one entry per check run. */
  reasons: string[];
  /** Human-readable summary when !verified. */
  rejectReason?: string;
  /** Time taken to verify (ms). */
  durationMs: number;
  /** Oracle identity. */
  oracleName: 'comprehension-oracle';
}

export interface VerifyComprehensionInput {
  message: ComprehendedTaskMessage;
  /** Same history the engine saw — oracle cross-checks against it. */
  history: ConversationEntry[];
  /** Same pending questions the engine saw. */
  pendingQuestions: string[];
  /**
   * Engine type declared by the orchestrator at registration time — NOT
   * read from the envelope. When present, enforces a tier ceiling
   * (A3/A5): LLM engines cannot claim `deterministic` or `heuristic`
   * regardless of self-report. Omitting this defaults to legacy
   * behavior (trust the envelope's tier at face value).
   */
  engineType?: ComprehensionEngineType;
}

/** Narrow helper — normalize for fuzzy "contains-this-text" checks. */
function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Return true when `needle` is contained in any history entry's content OR
 * in the literal goal. Used to verify that referenced text actually exists
 * somewhere in the session context — no hallucination.
 */
function isGroundedInSession(needle: string, history: readonly ConversationEntry[], literalGoal: string): boolean {
  const n = norm(needle);
  if (!n) return false;
  if (norm(literalGoal).includes(n)) return true;
  for (const entry of history) {
    if (norm(entry.content).includes(n)) return true;
  }
  return false;
}

/**
 * Run the oracle on an engine-produced envelope. Never throws — always
 * returns a verdict the orchestrator can route on.
 */
export function verifyComprehension(input: VerifyComprehensionInput): ComprehensionVerdict {
  const started = performance.now();
  const { message, history, pendingQuestions } = input;
  const reasons: string[] = [];

  // ── Unknown path: pass through. A2 says `unknown` is a valid state; the
  //                 orchestrator handles it separately (falls back to literal
  //                 goal) and we attest to the engine's honesty.
  if (message.params.type === 'unknown') {
    reasons.push('engine reported type=unknown; passing through');
    return {
      verified: true,
      type: 'unknown',
      confidence: 0,
      tier: 'unknown',
      reasons,
      durationMs: performance.now() - started,
      oracleName: 'comprehension-oracle',
    };
  }

  const data = message.params.data;
  // Schema-level invariant; if it fails, the engine is malformed — reject.
  if (!data) {
    reasons.push('type=comprehension but `data` missing');
    return {
      verified: false,
      type: 'contradictory',
      confidence: 0,
      tier: 'unknown',
      reasons,
      rejectReason: 'Engine emitted type=comprehension without data payload',
      durationMs: performance.now() - started,
      oracleName: 'comprehension-oracle',
    };
  }

  // ── Check 1: pending questions must match what the engine was told.
  //             Prevents the engine from fabricating clarification state.
  const engineQs = data.state.pendingQuestions;
  const mismatch = engineQs.length !== pendingQuestions.length || engineQs.some((q, i) => q !== pendingQuestions[i]);
  if (mismatch) {
    reasons.push(`pending-questions mismatch (engine=${engineQs.length}, oracle=${pendingQuestions.length})`);
    return {
      verified: false,
      type: 'contradictory',
      confidence: 0,
      tier: 'unknown',
      reasons,
      rejectReason: 'Engine fabricated or mutated the pending clarification questions',
      durationMs: performance.now() - started,
      oracleName: 'comprehension-oracle',
    };
  }
  reasons.push(`pending-questions match (${engineQs.length})`);

  // ── Check 2: isClarificationAnswer must be consistent with pendingQuestions.
  const expectClarification = pendingQuestions.length > 0;
  if (data.state.isClarificationAnswer !== expectClarification) {
    reasons.push(
      `isClarificationAnswer=${data.state.isClarificationAnswer} but pendingQuestions.length=${pendingQuestions.length}`,
    );
    return {
      verified: false,
      type: 'contradictory',
      confidence: 0,
      tier: 'unknown',
      reasons,
      rejectReason: 'isClarificationAnswer inconsistent with pendingQuestions',
      durationMs: performance.now() - started,
      oracleName: 'comprehension-oracle',
    };
  }
  reasons.push('state.isClarificationAnswer consistent with pending state');

  // ── Check 3: resolvedGoal must be grounded in session when it diverges
  //             from literalGoal. The only legitimate divergence path is
  //             root-goal anchoring, so resolvedGoal must appear as a prior
  //             user message in the history.
  if (data.resolvedGoal !== data.literalGoal) {
    const grounded = isGroundedInSession(data.resolvedGoal, history, data.literalGoal);
    if (!grounded) {
      reasons.push('resolvedGoal diverges from literalGoal but is not grounded in session history');
      return {
        verified: false,
        type: 'contradictory',
        confidence: 0,
        tier: 'unknown',
        reasons,
        rejectReason: 'Resolved goal appears fabricated (no session evidence)',
        durationMs: performance.now() - started,
        oracleName: 'comprehension-oracle',
      };
    }
    reasons.push('resolvedGoal grounded in session history');
  } else {
    reasons.push('resolvedGoal == literalGoal (no divergence to check)');
  }

  // ── Check 4: tier must be consistent with self-reported confidence.
  //             A5 tiered trust — if the engine says "deterministic" but
  //             confidence < 0.9, that's a misclamp.
  const tierMin: Record<string, number> = {
    deterministic: 0.9,
    heuristic: 0.5,
    probabilistic: 0,
    unknown: 0,
  };
  const declaredTier = message.params.tier;
  const minExpected = tierMin[declaredTier] ?? 0;
  if (message.params.confidence < minExpected) {
    reasons.push(`tier=${declaredTier} declares ≥${minExpected} but engine confidence=${message.params.confidence}`);
    return {
      verified: false,
      type: 'contradictory',
      confidence: message.params.confidence,
      tier: 'unknown',
      reasons,
      rejectReason: `Tier ${declaredTier} inconsistent with confidence ${message.params.confidence}`,
      durationMs: performance.now() - started,
      oracleName: 'comprehension-oracle',
    };
  }
  reasons.push(`tier=${declaredTier} consistent with confidence ${message.params.confidence}`);

  // ── Check 4b (A3/A5): per-engine-type tier ceiling.
  //   The engine's self-reported `tier` is honored only up to the ceiling
  //   imposed by its engineType. `llm` engines MAY NOT claim deterministic
  //   or heuristic — their outputs are fundamentally probabilistic, and
  //   governance decisions (intent routing, workflow dispatch) must not
  //   trust LLM self-assessment uncritically. A rogue/misconfigured LLM
  //   engine reporting `tier: 'deterministic'` is caught here instead of
  //   silently passing through.
  //
  //   When engineType is omitted (legacy callers), this check is skipped
  //   — backwards-compatible path for tests and pre-AXM#1 integrations.
  if (input.engineType) {
    const ceiling = maxTierForEngineType(input.engineType);
    if (tierRank(declaredTier) > tierRank(ceiling)) {
      reasons.push(
        `engineType=${input.engineType} caps tier at ${ceiling}, but engine self-reported ${declaredTier}`,
      );
      return {
        verified: false,
        type: 'contradictory',
        confidence: 0,
        tier: 'unknown',
        reasons,
        rejectReason: `Engine type '${input.engineType}' cannot claim tier '${declaredTier}' (max ${ceiling})`,
        durationMs: performance.now() - started,
        oracleName: 'comprehension-oracle',
      };
    }
    reasons.push(`engineType=${input.engineType} ceiling ${ceiling} honored`);
  }

  // ── Check 5: evidence_chain non-empty for non-unknown results.
  if (message.params.evidence_chain.length === 0) {
    reasons.push('evidence_chain is empty for a non-unknown result');
    return {
      verified: false,
      type: 'uncertain',
      confidence: 0,
      tier: 'unknown',
      reasons,
      rejectReason: 'No evidence provided for comprehension claim',
      durationMs: performance.now() - started,
      oracleName: 'comprehension-oracle',
    };
  }
  reasons.push(`evidence_chain has ${message.params.evidence_chain.length} entries`);

  // ── All checks passed. Carry forward the engine's self-reported tier
  //     and confidence; downstream tier-clamp (A5) may still clamp further
  //     if other signals disagree.
  return {
    verified: true,
    type: 'known',
    confidence: message.params.confidence,
    tier: declaredTier,
    reasons,
    durationMs: performance.now() - started,
    oracleName: 'comprehension-oracle',
  };
}
