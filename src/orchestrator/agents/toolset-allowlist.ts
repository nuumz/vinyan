/**
 * Toolset allowlist by persona role — Phase-6 risk M3 mitigation.
 *
 * A skill imported from the hub may declare `requires_toolsets` like
 * `['shell-exec', 'network-fetch']`. Even if the persona's `capabilityOverrides`
 * eventually deny those at runtime, an LLM reading a skill body that *expects*
 * shell access may try to call shell tools and confuse the user. The defense
 * line at acquisition time is: refuse to acquire skills whose toolsets are
 * outside the persona role's allowlist.
 *
 * Categorisation:
 *   - **Dangerous toolsets** require explicit role permission (shell, exec,
 *     network, write, mutation). Pattern-matched on `category:*` form.
 *   - **Safe toolsets** (read, lint, search, format, parse) are allowed for
 *     every role.
 *
 * The allowlist is intentionally tight — it's easier to relax than to revoke.
 * Phase 7 may extend it with explicit per-toolset-id grants.
 */
import type { PersonaRole } from '../types.ts';

/**
 * Dangerous toolset prefixes that require role permission. Format:
 * `category:*` where `category` is what we gate on.
 */
const DANGEROUS_PATTERNS: Record<string, RegExp> = {
  shell: /^(shell-|exec-|sh-|bash-|run-cmd)/i,
  network: /^(network-|http-|fetch-|curl-|api-)/i,
  write: /^(write-|fs-write|file-write|disk-write)/i,
  mutation: /^(mutate-|edit-|patch-|refactor-)/i,
};

/**
 * Per-role mapping of which dangerous toolset categories each role may
 * acquire. Roles not listed (e.g. `assistant`, `mentor`) may acquire only
 * safe toolsets — anything matching a DANGEROUS_PATTERNS regex is rejected.
 */
const ROLE_DANGEROUS_GRANTS: Record<PersonaRole, ReadonlyArray<keyof typeof DANGEROUS_PATTERNS>> = {
  // Generators that interact with code or systems get shell + write + mutation.
  developer: ['shell', 'write', 'mutation'],
  architect: ['write'], // designers write artifacts but rarely shell
  author: ['write'], // markdown writes
  // Researcher needs network for web research.
  researcher: ['network'],
  // Verifier never mutates and never shells.
  reviewer: [],
  // Coordinator routes; should not directly touch dangerous toolsets.
  coordinator: [],
  // Reflex / dialogue / personal-logistics are low-privilege.
  assistant: [],
  mentor: [],
  concierge: [],
};

/**
 * Returns true when every toolset id in `toolsets` is allowed for the given
 * persona role. Empty `toolsets` → trivially true (no toolset requirements).
 *
 * Safe (non-dangerous) toolsets are always allowed. Dangerous toolsets must
 * be in the role's grant list.
 */
export function areToolsetsAllowedForRole(role: PersonaRole | undefined, toolsets: readonly string[]): boolean {
  if (!role) return false; // unknown role: deny by default
  if (toolsets.length === 0) return true;
  const grants = ROLE_DANGEROUS_GRANTS[role];
  for (const toolset of toolsets) {
    const danger = matchDangerousCategory(toolset);
    if (danger === null) continue; // safe toolset — always allowed
    if (!grants.includes(danger)) return false;
  }
  return true;
}

/**
 * Map a toolset id to a dangerous category, or null when the id matches no
 * dangerous pattern (i.e. it's safe).
 */
export function matchDangerousCategory(toolsetId: string): keyof typeof DANGEROUS_PATTERNS | null {
  for (const [category, pattern] of Object.entries(DANGEROUS_PATTERNS) as Array<
    [keyof typeof DANGEROUS_PATTERNS, RegExp]
  >) {
    if (pattern.test(toolsetId)) return category;
  }
  return null;
}

/**
 * Exposed for tests + Phase 7 extensions. Mutating the returned arrays is
 * undefined behaviour — clone before edit.
 */
export function getRoleGrants(role: PersonaRole): ReadonlyArray<keyof typeof DANGEROUS_PATTERNS> {
  return ROLE_DANGEROUS_GRANTS[role];
}
