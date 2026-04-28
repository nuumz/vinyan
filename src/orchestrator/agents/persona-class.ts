/**
 * Persona class taxonomy — Phase-13 A1 Epistemic Separation surface.
 *
 * Personas are role-pure templates (Phase 1); each `PersonaRole` belongs to
 * one of three cognitive **classes** that the planner / dispatcher uses to
 * enforce A1:
 *
 *   - `generator` — produces artifacts (code, design, prose, research).
 *     Cannot evaluate its own output by A1.
 *   - `verifier`  — evaluates other personas' artifacts. Soul prompts may
 *     contain first-person verification verbs; other classes may not.
 *   - `mixed`     — routes work or has light reflex / dialogue / logistics
 *     duties (coordinator, assistant, mentor, concierge). Not a generator
 *     of large artifacts and not a dedicated verifier — these handle work
 *     where A1 is not the binding constraint.
 *
 * Why not enforce A1 at the engine level only?
 *   The autonomous skill creator already enforces `generatorEngineId !==
 *   criticEngineId` (Phase 4 / risk C3). That's necessary but not sufficient
 *   when the SAME engine is split across two personas — the LLM can't
 *   independently audit its own draft regardless of how the dispatcher
 *   labels the call. The taxonomy here lets the dispatcher refuse a Generator
 *   acting as its own Verifier *before* the LLM is invoked at all (A3:
 *   deterministic governance, no LLM in the governance path).
 *
 * Pure data + pure functions. No IO, no clock, no LLM. A3 compliant.
 */
import type { PersonaRole } from '../types.ts';

export type PersonaClass = 'generator' | 'verifier' | 'mixed';

/** Roles whose primary contribution is producing new artifacts. */
export const GENERATOR_ROLES: ReadonlyArray<PersonaRole> = ['developer', 'architect', 'author', 'researcher'];

/** Roles whose primary contribution is evaluating others' artifacts. */
export const VERIFIER_ROLES: ReadonlyArray<PersonaRole> = ['reviewer'];

/**
 * Roles that route, dispatch, or handle light reflex / dialogue / logistics
 * tasks where A1 is not the binding constraint. These can both produce small
 * artifacts and self-evaluate (e.g. an assistant deciding which of its own
 * answers to surface) without violating the A1 axiom — A1 binds the
 * generator/verifier *boundary* on substantial artifacts, not every micro-decision.
 */
export const MIXED_ROLES: ReadonlyArray<PersonaRole> = ['coordinator', 'assistant', 'mentor', 'concierge'];

/**
 * The persona id the registry returns from `findCanonicalVerifier()` when no
 * caller-supplied verifier is appropriate. Held as a constant so any code
 * path that needs "the default Verifier" agrees on the answer without
 * hard-coding the string.
 */
export const CANONICAL_VERIFIER_ROLE: PersonaRole = 'reviewer';

/**
 * Pure classifier — returns the persona class for a `PersonaRole`. Defaults
 * to `'mixed'` for unknown / undefined roles so legacy / user-authored
 * personas without a `role` field don't accidentally trip A1 guards.
 */
export function personaClassOf(role: PersonaRole | undefined): PersonaClass {
  if (!role) return 'mixed';
  if ((GENERATOR_ROLES as readonly string[]).includes(role)) return 'generator';
  if ((VERIFIER_ROLES as readonly string[]).includes(role)) return 'verifier';
  return 'mixed';
}

export interface A1PairCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Returns ok when the (generator, verifier) pair satisfies A1 Epistemic
 * Separation:
 *   - generator and verifier are not the SAME persona id (no self-verify)
 *   - if generator class is `'generator'`, verifier class must NOT be
 *     `'generator'` (must be `'verifier'` or `'mixed'`)
 *
 * `'mixed'` personas verifying generator output is allowed because they are
 * not themselves generators of substantial artifacts on the same task — the
 * common case is coordinator routing a verify sub-task. The strict path
 * (`verifier` class) is preferred and recommended; `'mixed'` is a
 * forgiveness slot for setups where no `reviewer` is registered.
 *
 * Two `'mixed'` or two `'verifier'` personas pair fine — A1 binds the
 * generator side of the boundary.
 */
export function assertA1Compatible(
  generatorRole: PersonaRole | undefined,
  generatorId: string,
  verifierRole: PersonaRole | undefined,
  verifierId: string,
): A1PairCheck {
  if (generatorId === verifierId) {
    return { ok: false, reason: `A1 violation: same persona '${generatorId}' on both generator and verifier sides` };
  }
  const genClass = personaClassOf(generatorRole);
  const verClass = personaClassOf(verifierRole);
  if (genClass === 'generator' && verClass === 'generator') {
    return {
      ok: false,
      reason:
        `A1 violation: generator persona '${generatorId}' (class=generator) paired with another generator persona ` +
        `'${verifierId}' (class=generator). Use a Verifier-class persona (e.g. 'reviewer') for the verify side.`,
    };
  }
  return { ok: true };
}
