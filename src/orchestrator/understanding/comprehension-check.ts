/**
 * Comprehension Check (PRE-generation) — orchestrator gate that runs
 * right after the Perceive phase, before any Predict/Plan/Generate work
 * commits budget.
 *
 * This file is one half of the two-phase Goal Alignment architecture
 * (see docs/design/agent-conversation.md → "Two-phase Goal Alignment"
 * section). The other half is the POST-generation verifier at
 * `src/oracle/goal-alignment/goal-alignment-verifier.ts`, which checks
 * the worker's actual mutations against the same `TaskUnderstanding`
 * this file vets for ambiguity.
 *
 *   Two-phase architecture:
 *     1. PRE-gen  (THIS FILE): "is the goal clear enough to act on?"
 *     2. Generate phase — worker produces mutations
 *     3. POST-gen (goal-alignment-verifier): "do the mutations match intent?"
 *
 *   Both are rule-based (A3), cap at heuristic tier 0.7 (A5), and operate
 *   with full epistemic separation from the generator (A1). They are
 *   complementary, not redundant.
 *
 * Operates on a `TaskUnderstanding` / `SemanticTaskUnderstanding` produced
 * by the Perceive phase. Detects clear goal ambiguities that the agent
 * cannot resolve by looking at more files, and returns user-facing
 * clarification questions BEFORE any Predict/Plan/Generate work commits
 * budget.
 *
 * Shared types with the post-gen verifier live in
 * `src/orchestrator/understanding/goal-alignment-shared.ts`.
 *
 * Axiom alignment:
 *   - A1 (Epistemic Separation): generation (the worker LLM) is the
 *     generator; this check is a separate verifier that does not run
 *     the same LLM. Closes the A1 gap at the Understanding layer that
 *     concept.md §1.1 flags — currently clarification decisions are
 *     agent-self-reported via `needsUserInput=true`, which conflates
 *     generation with verification.
 *   - A3 (Deterministic Governance): pure rule-based — no LLM, no
 *     probabilistic input. Every decision is reproducible from the
 *     same `TaskUnderstanding`.
 *   - A5 (Tiered Trust): heuristic tier — fires only on clearly
 *     ambiguous cases and falls back to "confident" by default, so
 *     it never blocks a task on a mere suspicion.
 *
 * Design: conservative V1. Two heuristics:
 *   H1 (multi-path entity)    — a referenced entity resolved to more
 *                               than one path with low confidence
 *   H4 (contradictory claims)  — any `verifiedClaim` resolved as
 *                               'contradictory'
 *
 * Not included in V1 (deliberately):
 *   H2 (missing targetSymbol)  — too noisy because the agent can
 *                                search for the symbol itself. Defer
 *                                until we have calibration data on
 *                                when this actually blocks progress.
 *   H3 (verb-mutation mismatch) — the current rule-based action-category
 *                                classifier is too coarse (maps common
 *                                verbs like "test" to category='qa' which
 *                                false-positives against taskType='code'
 *                                inputs). Defer until the classifier is
 *                                calibrated or a dedicated actionIntent
 *                                field with provenance exists.
 *   LLM semanticIntent.ambiguities — those come from an LLM, not
 *                                deterministic — including them in
 *                                a governance gate would violate A3.
 *                                They already enrich the agent's
 *                                prompt via buildInitUserMessage.
 */
import type { SemanticTaskUnderstanding, TaskUnderstanding } from '../types.ts';

/**
 * A failed comprehension heuristic. Each failed check contributes one
 * or more user-facing clarification questions.
 */
export interface FailedComprehensionCheck {
  /** Identifier for observability / tracing. */
  check: 'H1-ambiguous-entity' | 'H4-contradictory-claim';
  /** Short, machine-readable reason for the failure. */
  reason: string;
}

export interface ComprehensionVerdict {
  /**
   * True when zero heuristics failed. The core loop proceeds to Predict
   * only when `confident: true`. This field is the binary gate signal.
   */
  confident: boolean;
  /**
   * Informational derived confidence score in [0, 1]. Not used as the
   * gate threshold (that is `confident === true`) — surfaced for traces
   * and future calibration. Computed as `0.2 * max(0, 5 - failedCount)`
   * so a single failed check yields 0.8, two failed yields 0.6, etc.
   */
  confidence: number;
  /**
   * User-facing clarification questions, one or more per failed check.
   * Empty when `confident: true`. chat.ts / HTTP /messages render these
   * as the agent's `clarificationNeeded` array.
   */
  questions: string[];
  /**
   * Structured list of failed heuristics for observability. Used by
   * the `agent:clarification_requested` bus event payload.
   */
  failedChecks: FailedComprehensionCheck[];
}

export interface ComprehensionCheckOptions {
  /**
   * Entity resolution confidence below this value counts as ambiguous
   * for H1 (default: 0.6). Entities with only one resolved path bypass
   * H1 regardless — a single confident-or-not path is NOT ambiguous.
   */
  entityConfidenceThreshold?: number;
  /**
   * Maximum number of paths to include per H1 question (default: 4).
   * Longer lists truncate with "...".
   */
  maxPathsPerQuestion?: number;
  /**
   * When true, enables additional strict heuristics (reserved for
   * future use — V1 ignores this flag but accepts it for forward
   * compatibility).
   */
  strict?: boolean;
}

/**
 * Run the comprehension check on a `TaskUnderstanding`. Returns a
 * deterministic verdict — calling with the same understanding always
 * produces the same output.
 *
 * Pure function; no I/O, no side effects.
 */
export function checkComprehension(
  understanding: TaskUnderstanding | SemanticTaskUnderstanding,
  options: ComprehensionCheckOptions = {},
): ComprehensionVerdict {
  const entityThreshold = options.entityConfidenceThreshold ?? 0.6;
  const maxPaths = options.maxPathsPerQuestion ?? 4;

  const failedChecks: FailedComprehensionCheck[] = [];
  const questions: string[] = [];

  // ── H1: Multi-path ambiguous entity ────────────────────────────
  // If a user reference like "the helper" resolved to multiple files
  // and entity resolver couldn't pick one confidently, we cannot know
  // which file to operate on. Fire a clarification with the candidate
  // list so the user picks.
  const semantic = understanding as SemanticTaskUnderstanding;
  const entities = Array.isArray(semantic.resolvedEntities) ? semantic.resolvedEntities : [];
  for (const entity of entities) {
    if (
      entity
      && Array.isArray(entity.resolvedPaths)
      && entity.resolvedPaths.length > 1
      && typeof entity.confidence === 'number'
      && entity.confidence < entityThreshold
    ) {
      failedChecks.push({
        check: 'H1-ambiguous-entity',
        reason: `Entity "${entity.reference}" matched ${entity.resolvedPaths.length} paths at confidence ${entity.confidence.toFixed(2)} (< ${entityThreshold})`,
      });
      const shownPaths = entity.resolvedPaths.slice(0, maxPaths);
      const ellipsis = entity.resolvedPaths.length > maxPaths ? ', ...' : '';
      questions.push(
        `Which "${entity.reference}" did you mean? I found ${entity.resolvedPaths.length} possible matches: ${shownPaths.join(', ')}${ellipsis}.`,
      );
    }
  }

  // ── H4: Contradictory verified claims ──────────────────────────
  // A verified claim with type='contradictory' means the understanding
  // verifier found conflicting evidence about the world state (e.g.,
  // one source says the file exists at path A, another at path B).
  // The agent cannot resolve this — ask the user.
  const claims = Array.isArray(semantic.verifiedClaims) ? semantic.verifiedClaims : [];
  const contradictory = claims.filter((c) => c && c.type === 'contradictory');
  // Cap to 3 questions so a pathologically broken understanding
  // does not produce 50 questions in one response.
  for (const claim of contradictory.slice(0, 3)) {
    failedChecks.push({
      check: 'H4-contradictory-claim',
      reason: `Verified claim "${claim.claim}" resolved to type='contradictory'`,
    });
    questions.push(
      `I found contradictory evidence about "${claim.claim}" — could you confirm which is correct so I can proceed?`,
    );
  }

  // ── Compose verdict ────────────────────────────────────────────
  // Binary gate: confident iff zero failures.
  const confident = failedChecks.length === 0;
  // Informational score — linear penalty per failure, capped at 5 failures.
  const confidence = Math.max(0, Math.min(1, 1 - failedChecks.length * 0.2));

  return { confident, confidence, questions, failedChecks };
}

/**
 * Constraint prefix that disables the comprehension gate for a given
 * task. Clients (CLI, API, tests) that need to bypass the gate can
 * include this as an entry in `TaskInput.constraints`. Pipeline
 * metadata — never rendered in the agent's init prompt (filtered by
 * buildInitUserMessage).
 */
export const COMPREHENSION_CHECK_OFF_CONSTRAINT = 'COMPREHENSION_CHECK:off';

/**
 * Returns true if the given task has explicitly opted out of the
 * comprehension gate via the `COMPREHENSION_CHECK:off` constraint.
 */
export function isComprehensionCheckDisabled(constraints: readonly string[] | undefined): boolean {
  if (!constraints || constraints.length === 0) return false;
  return constraints.includes(COMPREHENSION_CHECK_OFF_CONSTRAINT);
}
