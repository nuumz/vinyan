/**
 * Reality-anchor state machine — Phase C4.
 *
 * Four persistent persona states track where in the recovery workflow
 * a persona currently sits:
 *
 *   - `active`        — normal operation; dispatch unrestricted
 *   - `quarantined`   — psychosis:trigger received; recovery starting
 *   - `rebuilding`    — sub-actions running (rebuild, prune, replay)
 *   - `shadow-mode`   — work permitted but in monitor-only mode until
 *                        N consecutive clean traces accumulate
 *
 * Five audit stages record the named workflow steps:
 *
 *   1. `quarantine` — entering `quarantined` from `active`
 *   2. `rebuild`    — entering `rebuilding` from `quarantined`; would
 *                     re-walk the persona's facts in a real
 *                     implementation (no-op in MVP)
 *   3. `prune`      — sub-action while `rebuilding`; would drop
 *                     probabilistic / tier-3 cached beliefs
 *   4. `replay`     — sub-action while `rebuilding`; would re-run the
 *                     last N decisions against current ground truth.
 *                     On completion the persona implicitly enters
 *                     `shadow-mode`.
 *   5. `reentry`    — `shadow-mode → active` after N clean traces
 *
 * The state machine is deliberately small — A3-honest, deterministic,
 * replayable. The actual work bodies for `rebuild` / `prune` / `replay`
 * are pluggable; the MVP fires their audit rows synchronously with
 * no-op work. Real workflow engines can hook in later without changing
 * the state graph.
 */

export const REALITY_ANCHOR_STATES = ['active', 'quarantined', 'rebuilding', 'shadow-mode'] as const;
export type RealityAnchorState = (typeof REALITY_ANCHOR_STATES)[number];

export const REALITY_ANCHOR_STAGES = ['quarantine', 'rebuild', 'prune', 'replay', 'reentry'] as const;
export type RealityAnchorStage = (typeof REALITY_ANCHOR_STAGES)[number];

/**
 * Allowed state transitions. The state machine is fail-closed: any
 * transition not listed here is rejected by `assertValidTransition`.
 *
 * Notable rules:
 *   - `active → quarantined` is the only entry into recovery (fired by
 *     `psychosis:trigger`)
 *   - `rebuilding → quarantined` is allowed so a fresh psychosis:trigger
 *     mid-recovery resets the workflow (defensive — operators probably
 *     don't want a half-rebuilt persona to advance to shadow if their
 *     state went *worse* during recovery)
 *   - `shadow-mode → quarantined` allowed for the same reason
 *   - No direct `quarantined → active` or `rebuilding → active`: the
 *     workflow MUST graduate through `shadow-mode` to ensure cleanliness
 *     is observed before commit privileges return
 */
const ALLOWED_TRANSITIONS: ReadonlySet<string> = new Set([
  'active->quarantined',
  'quarantined->rebuilding',
  'rebuilding->shadow-mode',
  'shadow-mode->active',
  // Defensive bounces — fresh trigger or shadow failure resets recovery
  'rebuilding->quarantined',
  'shadow-mode->quarantined',
]);

export class InvalidStateTransitionError extends Error {
  constructor(
    readonly from: RealityAnchorState,
    readonly to: RealityAnchorState,
  ) {
    super(`reality-anchor: transition ${from} → ${to} is not permitted`);
  }
}

export function isValidTransition(from: RealityAnchorState, to: RealityAnchorState): boolean {
  if (from === to) return true; // self-transitions are no-op (audit-only sub-actions)
  return ALLOWED_TRANSITIONS.has(`${from}->${to}`);
}

export function assertValidTransition(from: RealityAnchorState, to: RealityAnchorState): void {
  if (!isValidTransition(from, to)) throw new InvalidStateTransitionError(from, to);
}

/**
 * Whether a persona in this state may currently dispatch new tasks.
 * `quarantined` and `rebuilding` are paused (work is internal recovery,
 * not user-facing dispatch). `active` and `shadow-mode` permit dispatch
 * — shadow-mode results just don't commit until reentry.
 */
export function canDispatchInState(state: RealityAnchorState): boolean {
  return state === 'active' || state === 'shadow-mode';
}
