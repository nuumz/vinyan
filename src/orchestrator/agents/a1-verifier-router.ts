/**
 * A1 Verifier Router — shared helper that picks a canonical Verifier-class
 * persona for delegation sub-tasks on code-mutation parents.
 *
 * Two call sites consume this:
 *   - `workflow-executor.ts` `delegate-sub-agent` strategy (Phase 13)
 *   - `agent-loop.ts` `handleDelegation` callback (Phase 14 / Item 4)
 *
 * Keeping the routing logic in ONE place keeps the verb pattern, the
 * code-mutation gate, the canonical-verifier lookup, and the parent-already-verifier
 * defensive skip in lockstep across both surfaces. A future agentic dispatch
 * site (e.g. critic delegation) imports the same function.
 *
 * Pure: no IO, no LLM, no clock. A3 compliant — deterministic governance.
 */
import { asPersonaId, type PersonaId } from '../../core/agent-vocabulary.ts';
import type { TaskDomain } from '../types.ts';
import type { AgentRegistry } from './registry.ts';

/**
 * Verbs that mark a description as verification work. Mirrors
 * `SELF_VERIFICATION_PATTERN` in the agent registry (which lints persona
 * souls) but matches description text rather than first-person soul phrasing.
 *
 * Conservative — must be a whole word to avoid false positives like
 * "checkout", "evaluation criteria", etc.
 */
export const VERIFY_DESCRIPTION_PATTERN =
  /\b(verify|review|audit|critique|validate|evaluate|assess|sanity[-\s]?check)\b/i;

export interface A1VerifierRoutingInput {
  /** Free-text description of the sub-task — typically the step description or delegation goal. */
  description: string;
  /** Parent task's classified type. A1 binds on 'code' (code-mutation work). */
  parentTaskType: string | undefined;
  /** Persona id of the parent task, when set. Used to skip self-routing. */
  parentAgentId: string | undefined;
  /**
   * Phase-15 (Item 3): finer-grained signal from `TaskUnderstanding`.
   * `code-reasoning` (read-only "explain this function") suppresses the
   * override even when `parentTaskType === 'code'`, because no artifact is
   * produced — there's nothing for a Verifier to verify. Other domain
   * values (or undefined) keep the existing `parentTaskType === 'code'`
   * gate in force, so callers without TaskUnderstanding routing land back
   * on Phase-14 behaviour with no regression.
   */
  parentTaskDomain?: TaskDomain;
}

/**
 * Returns the canonical Verifier persona id when ALL hold:
 *   - parentTaskType === 'code' (A1 binds on code-mutation per the original
 *     Phase 1 plan)
 *   - description matches `VERIFY_DESCRIPTION_PATTERN`
 *   - registry has a canonical Verifier registered (`findCanonicalVerifier()`)
 *   - the parent is not already running as that Verifier (no self-route)
 *
 * Returns `null` otherwise so the caller falls through to legacy behaviour.
 */
export function selectVerifierForDelegation(
  routing: A1VerifierRoutingInput,
  registry: AgentRegistry,
): PersonaId | null {
  if (routing.parentTaskType !== 'code') return null;
  // Phase-15 Item 3: read-only code reasoning produces no artifact, so
  // there's nothing for a Verifier to verify — skip the override.
  if (routing.parentTaskDomain === 'code-reasoning') return null;
  if (!VERIFY_DESCRIPTION_PATTERN.test(routing.description)) return null;
  const verifier = registry.findCanonicalVerifier();
  if (!verifier) return null;
  if (routing.parentAgentId && routing.parentAgentId === verifier.id) return null;
  // Brand at the registry boundary. The registry contract guarantees
  // verifier.id is PersonaId-shaped; if a future bug violates that, the
  // throw surfaces it deterministically (A3) rather than letting a
  // malformed id drift through workflow + trace surfaces.
  return asPersonaId(verifier.id);
}
