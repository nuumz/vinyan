/**
 * Subprocess-side helper for stamping `subAgentId` on `audit:entry`
 * payloads.
 *
 * Ownership split:
 *   - Orchestrator (agent-loop): on delegate dispatch, sets
 *     `subAgentId === input.id` on the OrchestratorTurn 'init' payload
 *     (`src/orchestrator/protocol.ts`). The init schema bumped to add
 *     this field additively — older orchestrators omit it.
 *   - Subprocess (agent-worker-entry, future): on each `audit:entry`
 *     it emits, it calls `stampSubAgentId(initSubAgentId, entry)`. The
 *     helper either fills in `subAgentId` (when init carried it) or
 *     returns the entry untouched + bumps a missing-counter so an
 *     operator can detect orchestrator/subprocess version skew.
 *
 * Today no subprocess emits `audit:entry` directly — agent-loop in the
 * orchestrator process handles that path via `hierarchyFromInput`. This
 * helper is the wire-level contract for the upcoming subprocess emit
 * path; placing it here lets P2.8's tests pin the back-compat behaviour
 * without requiring a full subprocess round-trip integration test.
 */

let missingSubAgentIdCount = 0;

export function getMissingSubAgentIdCount(): number {
  return missingSubAgentIdCount;
}

export function resetMissingSubAgentIdCount(): void {
  missingSubAgentIdCount = 0;
}

/**
 * Stamp `subAgentId` on an audit-entry payload. Pure-ish: returns a new
 * object with the field set, or the original entry untouched + a counter
 * bump when the orchestrator did not provide a subAgentId on init. Never
 * throws.
 *
 * `entry` is typed as a generic record so callers don't have to import
 * the AuditEntry type here (the subprocess builds raw JSON before wire
 * send; the orchestrator parses on receive).
 */
export function stampSubAgentId<T extends Record<string, unknown>>(initSubAgentId: string | undefined, entry: T): T {
  if (!initSubAgentId) {
    missingSubAgentIdCount += 1;
    if (missingSubAgentIdCount === 1) {
      console.warn(
        '[subagent-stamp] init payload lacks subAgentId — older orchestrator? Falling back; parent-side hierarchyFromInput still scopes events correctly.',
      );
    }
    return entry;
  }
  // Idempotent — if the entry already has subAgentId (e.g. orchestrator
  // pre-stamped it), respect that value rather than overwriting.
  if (typeof entry.subAgentId === 'string' && entry.subAgentId.length > 0) return entry;
  return { ...entry, subAgentId: initSubAgentId };
}
