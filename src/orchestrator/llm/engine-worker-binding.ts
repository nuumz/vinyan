/**
 * Engine ↔ Worker id binding — the canonical mapping between a Reasoning
 * Engine's runtime id and its lifecycle Worker Profile id in `workerStore`.
 *
 * Why a typed module instead of inline string concatenation:
 *   - The convention (`worker-` prefix) was previously duplicated across
 *     6+ call sites (factory.autoRegisterWorkers, server.composeEngineList,
 *     llm-reasoning-engine.selectById, provider-registry.selectById, etc.).
 *     Changing the prefix or scheme would require coordinated edits with
 *     no compiler help — exactly the bug class that produced the
 *     "duplicate engine rows" production incident.
 *   - Wrapping it as a typed function makes the relationship discoverable
 *     (jump-to-definition from any caller) and the invariant testable
 *     (`engineIdFromWorker(workerIdForEngine(x)) === x`).
 *   - This module has zero downstream imports — both registries can import
 *     it without creating a cycle.
 */

/**
 * Stable prefix used by `workerStore` row ids. Kept as a named export so
 * SQL migrations / external tooling can reference the same constant.
 *
 * Historical note: the prefix predates the RE-agnostic registry. Renaming
 * it would require a destructive worker_profiles migration, so the prefix
 * itself is part of the schema contract.
 */
export const WORKER_ID_PREFIX = 'worker-';

/** Build the canonical worker profile id for a given engine id. */
export function workerIdForEngine(engineId: string): string {
  return `${WORKER_ID_PREFIX}${engineId}`;
}

/**
 * Recover the engine id from a worker profile id. Returns the input
 * unchanged when the prefix is absent — handy for callers that may receive
 * either form (legacy traces, externally-supplied ids, ad-hoc test
 * fixtures).
 */
export function engineIdFromWorker(workerId: string): string {
  return workerId.startsWith(WORKER_ID_PREFIX) ? workerId.slice(WORKER_ID_PREFIX.length) : workerId;
}
