/**
 * Agent Vocabulary — branded ID types and runtime helpers.
 *
 * Disambiguates the five distinct concepts conflated under "agent" in
 * Vinyan. Source of truth: `docs/foundation/agent-vocabulary.md`.
 *
 *   #1 Persona              — internal role/specialist (developer, reviewer, ...)
 *   #2 Worker               — agentic-worker subprocess (Phase 6)
 *   #3 CLI Delegate         — external coding CLI (Claude Code, GitHub Copilot)
 *   #4 Host CLI             — dev-time tool used to BUILD Vinyan; not a runtime concept
 *   #5 Peer Instance        — Vinyan-as-A2A-peer
 *
 * #4 has no runtime type because Vinyan does not see it. The other four
 * get branded string types here so new code can express *which* kind of
 * agent it's talking about at compile time.
 *
 * Adoption is gradual. Existing `agentId: string` callers stay; new code
 * uses the branded type. See the "Branded ID adoption" RFC in the
 * vocabulary doc.
 */

// ── Branded types ───────────────────────────────────────────────────────

declare const PersonaIdBrand: unique symbol;
declare const WorkerIdBrand: unique symbol;
declare const PeerInstanceIdBrand: unique symbol;

/** #1 — Vinyan internal persona / specialist (developer, reviewer, coordinator, ...). */
export type PersonaId = string & { readonly [PersonaIdBrand]: never };

/** #2 — Vinyan agentic worker subprocess identifier (Phase 6). */
export type WorkerId = string & { readonly [WorkerIdBrand]: never };

/** #3 — External coding CLI provider id. Closed union — every supported provider is enumerated. */
export type CliDelegateProviderId = 'claude-code' | 'github-copilot';

/** #5 — A2A peer Vinyan instance identifier. */
export type PeerInstanceId = string & { readonly [PeerInstanceIdBrand]: never };

// ── Constructors ────────────────────────────────────────────────────────

/** Validate + brand a persona id. Lowercase ASCII slug, 1-64 chars. */
export function asPersonaId(value: string): PersonaId {
  if (!isPersonaIdShape(value)) {
    throw new Error(`agent-vocabulary: invalid PersonaId "${value}" (expected /^[a-z][a-z0-9-]{0,63}$/)`);
  }
  return value as PersonaId;
}

/**
 * Non-throwing PersonaId constructor for read boundaries (DB
 * deserialization, IPC). Returns `undefined` for `null`/`undefined`/
 * shape mismatch, so a legacy row carrying a malformed agent_id
 * surfaces as "missing" rather than as a typed `string` masquerading
 * as a PersonaId. Bounded degradation (A9) without silent fallback to
 * bare string.
 */
export function tryAsPersonaId(value: string | null | undefined): PersonaId | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPersonaIdShape(value)) return undefined;
  return value as PersonaId;
}

/** Validate + brand a worker id. Lowercase ASCII slug or worker-NNN style. */
export function asWorkerId(value: string): WorkerId {
  if (!isWorkerIdShape(value)) {
    throw new Error(`agent-vocabulary: invalid WorkerId "${value}"`);
  }
  return value as WorkerId;
}

/** Validate + brand a peer instance id. */
export function asPeerInstanceId(value: string): PeerInstanceId {
  if (!isPeerInstanceIdShape(value)) {
    throw new Error(`agent-vocabulary: invalid PeerInstanceId "${value}"`);
  }
  return value as PeerInstanceId;
}

// ── Shape predicates (no throwing — for use in `if` guards) ────────────

const PERSONA_ID_RE = /^[a-z][a-z0-9-]{0,63}$/;
const WORKER_ID_RE = /^[a-z][a-z0-9-_:.]{0,127}$/;
const PEER_INSTANCE_ID_RE = /^[a-z][a-z0-9-_:.]{0,127}$/;

export function isPersonaIdShape(value: string): boolean {
  return PERSONA_ID_RE.test(value);
}

export function isWorkerIdShape(value: string): boolean {
  return WORKER_ID_RE.test(value);
}

export function isCliDelegateProviderId(value: string): value is CliDelegateProviderId {
  return value === 'claude-code' || value === 'github-copilot';
}

export function isPeerInstanceIdShape(value: string): boolean {
  return PEER_INSTANCE_ID_RE.test(value);
}

// ── Provider registry for #3 ────────────────────────────────────────────

/**
 * Closed list of supported CLI Delegate providers. Adding a new vendor
 * means appending here AND adding the adapter under
 * `src/orchestrator/external-coding-cli/providers/`.
 */
export const CLI_DELEGATE_PROVIDER_IDS: readonly CliDelegateProviderId[] = [
  'claude-code',
  'github-copilot',
] as const;

// ── Trust-tier mapping ──────────────────────────────────────────────────

/**
 * Default trust tier for each agent dimension. Consumers should NOT
 * use this as a substitute for runtime trust ledgers — it's a
 * conservative default for code that hasn't yet been trust-aware.
 *
 *   #1 Persona      → 'internal-trusted' — runs in Vinyan process
 *   #2 Worker       → 'zero-trust'       — A6 subprocess, must verify
 *   #3 CLI Delegate → 'zero-trust'       — A6 + A1, must verify
 *   #5 Peer         → 'earned'           — PeerTrustLevel from ledger
 *
 * #4 (Host CLI) has no runtime trust because it has no runtime presence.
 */
export type AgentTrustTier =
  | 'internal-trusted'
  | 'zero-trust'
  | 'earned';

export const PERSONA_DEFAULT_TRUST: AgentTrustTier = 'internal-trusted';
export const WORKER_DEFAULT_TRUST: AgentTrustTier = 'zero-trust';
export const CLI_DELEGATE_DEFAULT_TRUST: AgentTrustTier = 'zero-trust';
export const PEER_DEFAULT_TRUST: AgentTrustTier = 'earned';

// ── Discriminator ──────────────────────────────────────────────────────

/**
 * Five-dimension discriminator. Use in places that genuinely need to
 * distinguish at runtime (rare — most subsystems already know which
 * kind they're handling because each lives in its own module).
 *
 * `host-cli` is included for completeness so the type matches the
 * vocabulary doc, but no runtime API should ever return it — it's a
 * dev-time concept by definition.
 */
export const AGENT_KINDS = ['persona', 'worker', 'cli-delegate', 'peer', 'host-cli'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/**
 * Map an `AgentKind` to its default trust tier. `host-cli` returns
 * `internal-trusted` only because the human developer is the trust
 * anchor — code that needs to make a runtime decision based on this
 * should never see `host-cli` in the first place.
 */
export function defaultTrustForKind(kind: AgentKind): AgentTrustTier {
  switch (kind) {
    case 'persona':
      return PERSONA_DEFAULT_TRUST;
    case 'worker':
    case 'cli-delegate':
      return 'zero-trust';
    case 'peer':
      return PEER_DEFAULT_TRUST;
    case 'host-cli':
      return 'internal-trusted';
  }
}
