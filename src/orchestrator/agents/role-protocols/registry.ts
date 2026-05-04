/**
 * RoleProtocol registry — Phase A1 module-scoped lookup.
 *
 * Mirrors `src/oracle/registry.ts:23-59`: a static map of built-in
 * protocols + a dynamic map for runtime registration. Phase A1 ships the
 * registry with NO entries; Phase A2 adds `researcher.investigate` to
 * `BUILTIN_PROTOCOLS`.
 *
 * Lookup is O(1). Registration validates the protocol shape (id format,
 * unique step ids, preconditions reference existing steps); validation
 * failures throw because misconfigured protocols are author bugs, not
 * runtime conditions worth degrading over (A6 fail-closed).
 */

import type { RoleProtocol, RoleProtocolId } from './types.ts';

const BUILTIN_PROTOCOLS: Readonly<Record<string, RoleProtocol>> = {};
const dynamicProtocols = new Map<string, RoleProtocol>();

/** Look up a protocol by id. Returns `undefined` when not registered. */
export function getRoleProtocol(id: string): RoleProtocol | undefined {
  return dynamicProtocols.get(id) ?? BUILTIN_PROTOCOLS[id];
}

/** Enumerate every registered protocol id. Built-ins first, then dynamic. */
export function listRoleProtocolIds(): string[] {
  return [...Object.keys(BUILTIN_PROTOCOLS), ...dynamicProtocols.keys()];
}

/**
 * Register a protocol at runtime. Validates structural invariants and
 * throws on violation. Re-registering the same id overwrites — operators
 * use this seam to swap out a built-in protocol with a workspace override.
 */
export function registerRoleProtocol(protocol: RoleProtocol): void {
  validateProtocol(protocol);
  dynamicProtocols.set(protocol.id, protocol);
}

/** Remove a dynamically registered protocol. Returns true when removed. */
export function unregisterRoleProtocol(id: RoleProtocolId | string): boolean {
  return dynamicProtocols.delete(id);
}

/** Reset the dynamic registry — for tests. Built-ins are not affected. */
export function clearDynamicRoleProtocols(): void {
  dynamicProtocols.clear();
}

/**
 * Structural validation. Throws an `Error` with a clear message on
 * violation; does not return a partial result. Misconfigured protocols
 * are author bugs.
 *
 * Checks:
 *   1. `id` matches the branded format (lowercase dot-namespaced).
 *   2. `steps` is non-empty.
 *   3. Every step id is unique within the protocol.
 *   4. Every `preconditions` entry references an earlier step (DAG, not
 *      a cycle — order in `steps` is the topological order).
 *   5. `targetFilesFromStep` references an existing step.
 *   6. `exitCriteria` of kind `'oracle-pass'` references an oracle hook
 *      declared by at least one step (otherwise the criterion is
 *      unsatisfiable by construction).
 */
export function validateProtocol(protocol: RoleProtocol): void {
  if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(protocol.id)) {
    throw new Error(
      `RoleProtocol "${protocol.id}": id must be lowercase dot-namespaced (e.g. 'researcher.investigate').`,
    );
  }
  if (protocol.steps.length === 0) {
    throw new Error(`RoleProtocol "${protocol.id}": must declare at least one step.`);
  }

  const seen = new Set<string>();
  const declaredOracles = new Set<string>();
  for (const [index, step] of protocol.steps.entries()) {
    if (seen.has(step.id)) {
      throw new Error(`RoleProtocol "${protocol.id}": duplicate step id "${step.id}".`);
    }
    seen.add(step.id);

    for (const pre of step.preconditions ?? []) {
      if (!seen.has(pre)) {
        throw new Error(
          `RoleProtocol "${protocol.id}": step "${step.id}" precondition "${pre}" must reference an earlier step (not "${pre}", at index ${index}).`,
        );
      }
    }

    if (step.targetFilesFromStep && !seen.has(step.targetFilesFromStep)) {
      throw new Error(
        `RoleProtocol "${protocol.id}": step "${step.id}" targetFilesFromStep "${step.targetFilesFromStep}" must reference an earlier step.`,
      );
    }

    for (const hook of step.oracleHooks ?? []) {
      declaredOracles.add(hook.oracleName);
    }
  }

  for (const criterion of protocol.exitCriteria ?? []) {
    if (criterion.kind === 'oracle-pass' && !declaredOracles.has(criterion.oracleName)) {
      throw new Error(
        `RoleProtocol "${protocol.id}": exit criterion references oracle "${criterion.oracleName}" but no step declares that hook.`,
      );
    }
    if (criterion.kind === 'evidence-confidence' && (criterion.threshold < 0 || criterion.threshold > 1)) {
      throw new Error(
        `RoleProtocol "${protocol.id}": evidence-confidence threshold ${criterion.threshold} out of range [0, 1].`,
      );
    }
    if (criterion.kind === 'step-count' && criterion.minSteps < 1) {
      throw new Error(`RoleProtocol "${protocol.id}": step-count minSteps ${criterion.minSteps} must be ≥ 1.`);
    }
  }
}
