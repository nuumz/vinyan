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
declare const SessionIdBrand: unique symbol;
declare const TaskIdBrand: unique symbol;
declare const SubTaskIdBrand: unique symbol;
declare const StepIdBrand: unique symbol;
declare const SubAgentIdBrand: unique symbol;

/** #1 — Vinyan internal persona / specialist (developer, reviewer, coordinator, ...). */
export type PersonaId = string & { readonly [PersonaIdBrand]: never };

/** #2 — Vinyan agentic worker subprocess identifier (Phase 6). */
export type WorkerId = string & { readonly [WorkerIdBrand]: never };

/** #3 — External coding CLI provider id. Closed union — every supported provider is enumerated. */
export type CliDelegateProviderId = 'claude-code' | 'github-copilot';

/** #5 — A2A peer Vinyan instance identifier. */
export type PeerInstanceId = string & { readonly [PeerInstanceIdBrand]: never };

// ── Hierarchy ids (Phase 2 audit redesign) ─────────────────────────────

/**
 * Session id — chat-container identifier created by SessionManager. UUID-shape
 * by convention but not enforced; treat as opaque. Used to scope all
 * `session_*` table rows and to populate the `task_events.session_id` column.
 */
export type SessionId = string & { readonly [SessionIdBrand]: never };

/**
 * Task id. Two shapes coexist:
 *   - root tasks: opaque (UUID-shaped in practice).
 *   - sub-tasks: deterministic `${parentTaskId}-{delegate|wf|coding-cli|child}-{stepId}[-r{round}]`,
 *     constructed at `src/orchestrator/workflow/stage-manifest.ts` and the
 *     workflow-executor delegate path. Sub-task ids are also `TaskId`s — they
 *     own their own `task_events` rows. The branded type is permissive on
 *     shape so existing emitters that already pass `string` keep working.
 */
export type TaskId = string & { readonly [TaskIdBrand]: never };

/**
 * Sub-task id — load-bearing alias of TaskId carved out so call sites that
 * specifically address the *child* task in a delegate / collaboration / wf /
 * coding-cli relationship can express that intent at the type level.
 * Equality with TaskId is intentional: every SubTaskId IS a TaskId in the
 * persistence layer. The brand exists only to flag the audit-shape role.
 */
export type SubTaskId = string & { readonly [SubTaskIdBrand]: never };

/**
 * Workflow id — DOCUMENTATION ALIAS for `TaskId`. Vinyan does not maintain
 * a separate workflow identity; one workflow is implicit per task. The
 * branded type exists so the audit shape reads honestly: a `workflowId`
 * field on the wrapper conveys "this row pertains to the workflow plan
 * scoped to this task" without forking a real id. Treat
 * `workflowId === taskId` as an invariant. Re-plans surface via
 * `kind:'workflow'` audit entries carrying `planHash`.
 */
export type WorkflowId = TaskId;

/**
 * Step id — workflow-step identifier (`step1`, `step2`, …). Format is
 * `^step\d+$` per the planner system prompt; we do NOT enforce the regex
 * on the brand because legacy emitters use bare `string` and we want
 * branding to be incremental.
 */
export type StepId = string & { readonly [StepIdBrand]: never };

/**
 * Sub-Agent id — distinct identity for a delegate spawned via
 * `delegate-sub-agent`. Equal to the spawned sub-task id by convention
 * (the sub-task IS the sub-agent's identity); we keep a separate brand
 * so audit-emit sites express intent ("this is the sub-agent dimension")
 * and so future moves to a non-1:1 scheme do not require renaming every
 * call site. Today: `subAgentId === subTaskId` for every delegate.
 */
export type SubAgentId = string & { readonly [SubAgentIdBrand]: never };

// ── Constructors ────────────────────────────────────────────────────────

/** Validate + brand a persona id. Lowercase ASCII slug, 1-64 chars. */
export function asPersonaId(value: string): PersonaId {
  if (!isPersonaIdShape(value)) {
    throw new Error(`agent-vocabulary: invalid PersonaId "${value}" (expected /^[a-z][a-z0-9-]{0,63}$/)`);
  }
  return value as PersonaId;
}

/**
 * Brand a non-empty string as a SessionId. Permissive — the SessionManager
 * mints UUIDs but consumers (CLI / API) may pass through legacy shapes; we
 * trust the source and only reject empty strings.
 */
export function asSessionId(value: string): SessionId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('agent-vocabulary: SessionId must be a non-empty string');
  }
  return value as SessionId;
}

export function tryAsSessionId(value: string | null | undefined): SessionId | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value as SessionId;
}

/**
 * Brand a non-empty string as a TaskId. Both root and sub-task ids land
 * here — the SubTaskId brand is the intent marker, not a shape-stricter
 * sibling.
 */
export function asTaskId(value: string): TaskId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('agent-vocabulary: TaskId must be a non-empty string');
  }
  return value as TaskId;
}

export function tryAsTaskId(value: string | null | undefined): TaskId | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value as TaskId;
}

export function asSubTaskId(value: string): SubTaskId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('agent-vocabulary: SubTaskId must be a non-empty string');
  }
  return value as SubTaskId;
}

export function tryAsSubTaskId(value: string | null | undefined): SubTaskId | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value as SubTaskId;
}

/**
 * Brand a non-empty string as a StepId. The planner emits `step\d+` shapes
 * but we do not enforce — emitters with non-canonical step ids would
 * otherwise fail at the audit-emit boundary, hiding the upstream bug.
 */
export function asStepId(value: string): StepId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('agent-vocabulary: StepId must be a non-empty string');
  }
  return value as StepId;
}

export function tryAsStepId(value: string | null | undefined): StepId | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value as StepId;
}

export function asSubAgentId(value: string): SubAgentId {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('agent-vocabulary: SubAgentId must be a non-empty string');
  }
  return value as SubAgentId;
}

export function tryAsSubAgentId(value: string | null | undefined): SubAgentId | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value as SubAgentId;
}

/**
 * Today's invariant: a sub-agent's identity equals the sub-task it owns
 * (one-delegate-step → one-sub-task → one-sub-agent). Centralised so a
 * future move to non-1:1 is one edit.
 */
export function subAgentIdFromSubTask(subTaskId: SubTaskId): SubAgentId {
  return subTaskId as unknown as SubAgentId;
}

/**
 * Companion to `subAgentIdFromSubTask` — recover the sub-task id when an
 * audit row is keyed by SubAgentId. Symmetric with the above by design.
 */
export function subTaskIdFromSubAgent(subAgentId: SubAgentId): SubTaskId {
  return subAgentId as unknown as SubTaskId;
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
export const CLI_DELEGATE_PROVIDER_IDS: readonly CliDelegateProviderId[] = ['claude-code', 'github-copilot'] as const;

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
export type AgentTrustTier = 'internal-trusted' | 'zero-trust' | 'earned';

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
