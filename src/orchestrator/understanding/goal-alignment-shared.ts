/**
 * Goal Alignment — shared types between the pre-gen Comprehension Check
 * and the post-gen Goal Alignment Verifier.
 *
 * The two oracles are complementary halves of a two-phase architecture
 * (see docs/design/agent-conversation.md → "Two-phase Goal Alignment"):
 *
 *   PRE-generation (Comprehension Check):
 *     src/orchestrator/understanding/comprehension-check.ts
 *     Question: "is the goal clear enough to act on?"
 *     Fires: right after Perceive, before Predict
 *     Input: TaskUnderstanding
 *     Output: GoalAlignmentPhaseVerdict with phase: 'pre-generation'
 *
 *   POST-generation (Goal Alignment Verifier):
 *     src/oracle/goal-alignment/goal-alignment-verifier.ts
 *     Question: "do the mutations match what the user asked for?"
 *     Fires: during Verify, against a HypothesisTuple with mutations
 *     Input: HypothesisTuple + TaskUnderstanding + targetFiles
 *     Output: OracleResponse (legacy shape, wrapping GoalAlignmentPhaseVerdict semantics)
 *
 * Both phases:
 *   - Rule-based (A3): no LLM in the verdict path
 *   - Heuristic tier (A5): confidence capped at 0.7
 *   - Epistemic Separation (A1): a separate component from the worker
 *     LLM that produced the TaskUnderstanding / mutations being checked
 *
 * This file exists to document the shared contract and give downstream
 * code a single place to import common types. It intentionally does NOT
 * alter the existing verifier's OracleResponse shape — that would
 * cascade through oracle registry, gate.ts, and trace schema. Instead,
 * the shared types are used by NEW code paths and for observability.
 */

/**
 * Identifies which phase of the two-phase Goal Alignment architecture
 * produced a verdict. Used by shared observability code to tag events
 * so downstream listeners can distinguish pre-gen from post-gen signals
 * in the same bus event stream.
 */
export type GoalAlignmentPhase = 'pre-generation' | 'post-generation';

/**
 * Common heuristic-tier cap applied by BOTH the Comprehension Check
 * (hardcoded in checkComprehension's confidence derivation) and the
 * Goal Alignment Verifier (`MAX_CONFIDENCE = 0.7`). Exported here so
 * future code paths can reference a single constant rather than
 * duplicating the magic number.
 */
export const GOAL_ALIGNMENT_HEURISTIC_CAP = 0.7 as const;

/**
 * A unified verdict shape that both phases can produce for observability
 * and future cross-phase composition. The existing Goal Alignment Verifier
 * still returns the legacy `OracleResponse` (required by the oracle
 * registry); this shape is additive — a wrapper / view that callers can
 * build from either the Comprehension verdict or an OracleResponse.
 *
 * Not intended to replace either oracle's native output. Intended for:
 *   - Shared telemetry / bus events
 *   - Future code that wants to reason about "any goal-alignment signal"
 *     regardless of which phase produced it
 *   - Trace metadata consolidation
 */
export interface GoalAlignmentPhaseVerdict {
  /** Which phase produced this verdict. */
  phase: GoalAlignmentPhase;
  /**
   * True when the verdict passes — phase-specific meaning:
   *   - pre-generation: no ambiguity detected, safe to proceed to Generate
   *   - post-generation: mutations align with intent, safe to commit
   */
  aligned: boolean;
  /**
   * Confidence in the verdict, bounded in [0, GOAL_ALIGNMENT_HEURISTIC_CAP].
   * Both phases cap at the heuristic tier — neither can produce a
   * deterministic-tier verdict because both use approximate rules
   * (entity-resolver fuzz, verb classifier coarseness, etc.).
   */
  confidence: number;
  /**
   * Human-readable reasons for misalignment. Empty when aligned=true.
   * In the pre-generation phase these become user-facing clarification
   * questions; in the post-generation phase they become warnings in
   * the oracle accuracy log.
   */
  reasons: string[];
  /**
   * Short identifiers for the specific heuristics / checks that fired.
   * Used by observability to track per-check rates over time.
   *   - pre-gen: 'H1-ambiguous-entity' | 'H4-contradictory-claim' | ...
   *   - post-gen: 'C1-mutation-expectation' | 'C2-symbol-coverage' | ...
   */
  failedCheckIds: string[];
}
