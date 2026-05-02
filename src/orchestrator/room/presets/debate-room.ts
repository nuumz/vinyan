/**
 * Debate Room Preset (Phase 3 multi-agent debate fix).
 *
 * Builds a `RoomContract` from a `CollaborationDirective`. The contract has
 * exactly `directive.requestedPrimaryParticipantCount` primary-participant
 * roles (one per requested agent), zero or one oversight role (only when
 * `reviewerPolicy === 'explicit'`, never inflating the primary count), and
 * zero or one integrator role (skipped only for `interactionMode='parallel-answer'`).
 *
 * Persona selection prefers generator-class personas (developer, architect,
 * author, researcher) for primary roles, falls back to mixed-class
 * (mentor, assistant, concierge) when the generator pool is too small,
 * and NEVER selects the canonical verifier (`reviewer`) as a primary —
 * that persona is reserved for oversight to preserve A1 even though
 * primaries do not verify each other.
 *
 * The contract is `outputMode='text-answer'`, so the supervisor's
 * convergence path uses turn counts (no mutation gate, no goal-alignment
 * verifier). The dispatcher's per-round role gate runs primaries on
 * rounds [0, rebuttalRounds] and the integrator only on the final round.
 */
import { type PersonaId, tryAsPersonaId } from '../../../core/agent-vocabulary.ts';
import { personaClassOf } from '../../agents/persona-class.ts';
import type { AgentRegistry } from '../../agents/registry.ts';
import type { CollaborationDirective } from '../../intent/collaboration-parser.ts';
import type { AgentSpec } from '../../types.ts';
import type { RoleSpec, RoomContract } from '../types.ts';

/**
 * Per-turn token budget estimate. Conservative — the supervisor enforces
 * the contract's overall `tokenBudget` as a hard cap; the per-turn figure
 * is just a sizing estimate. Anthropic claude-opus single-turn answers in
 * the 1.5-3k range are typical; 4k leaves headroom for verbose rebuttals.
 */
const PER_TURN_TOKEN_BUDGET = 4_000;

/**
 * Default persona id used for the integrator role. Falls back to the
 * registry's default agent when this id is not registered.
 */
const DEFAULT_INTEGRATOR_PERSONA_ID = 'coordinator';

/**
 * Text-answer rooms are not gated on goal-alignment, so this threshold is
 * informational only. Set conservatively low so any future re-introduction
 * of a goal-alignment check does not accidentally block convergence on
 * subjective Q&A goals where the verifier struggles.
 */
const TEXT_ANSWER_CONVERGENCE_THRESHOLD = 0.5;

export interface DebateRoomBuildOptions {
  parentTaskId: string;
  goal: string;
  directive: CollaborationDirective;
  registry: AgentRegistry;
  /** Override per-turn token estimate (defaults to PER_TURN_TOKEN_BUDGET). */
  perTurnTokenBudget?: number;
  /**
   * Pre-selected primary persona ids — bypasses the alphabetical-by-class
   * fallback in `selectPrimaryAgents`. Supplied by `selectPersonasViaLLM`
   * so persona choice is content-aware (developer/architect for code,
   * author for prose, researcher for inquiry) instead of always returning
   * `architect, author, developer` for any 3-agent request. Must be of
   * length `directive.requestedPrimaryParticipantCount`; ids must exist
   * in the registry; on any validation failure the builder falls back
   * to the deterministic alphabetical path.
   */
  preferredPrimaryIds?: readonly PersonaId[];
  /**
   * Pre-selected integrator persona id — overrides the
   * `coordinator → registry.defaultAgent()` fallback chain. Validated the
   * same way as `preferredPrimaryIds`; failed validation drops back to
   * the default. Ignored when `directive.interactionMode='parallel-answer'`
   * (no integrator in that mode).
   */
  preferredIntegratorId?: PersonaId;
  /**
   * Phase D — persona overlay map (persona id → goal-specific framing
   * text). When supplied, the role builder concatenates the overlay
   * onto the persona's stock responsibility text so each primary's
   * perspective is differentiated for THIS goal. Unused ids are simply
   * dropped (no error). Drafted by `draftPersonaOverlay()` in the
   * selector module — pure addition; the persona's registered soul is
   * untouched.
   */
  personaOverlays?: ReadonlyMap<string, string>;
}

/**
 * Bundle returned to the collaboration runner. Carries the contract plus
 * the persona ids selected for each role-class so the runner can populate
 * `WorkflowStageManifest.collaboration` without re-parsing the contract.
 */
export interface DebateRoomContractBundle {
  contract: RoomContract;
  /** Persona ids selected for primary roles, in dispatch order. */
  primaryParticipantIds: PersonaId[];
  /** Persona id for oversight role; null when reviewerPolicy !== 'explicit'. */
  oversightParticipantId: PersonaId | null;
  /** Persona id for integrator role; null for parallel-answer mode. */
  integratorParticipantId: PersonaId | null;
}

/** Thrown when the registry has too few non-verifier personas to honour the directive. */
export class DebateRoomBuildFailure extends Error {
  override readonly name = 'DebateRoomBuildFailure';
  constructor(
    message: string,
    public readonly availableCount: number,
    public readonly requestedCount: number,
  ) {
    super(message);
  }
}

/**
 * Pure preset builder — no I/O, no LLM, no clock. Same inputs always
 * produce the same contract; the registry snapshot is captured at call
 * time via `registry.listAgents()`.
 */
export function buildDebateRoomContract(opts: DebateRoomBuildOptions): DebateRoomContractBundle {
  const { directive, registry } = opts;

  const primaryAgents = selectPrimaryAgents(
    registry.listAgents(),
    directive.requestedPrimaryParticipantCount,
    opts.preferredPrimaryIds,
  );
  if (primaryAgents.length < directive.requestedPrimaryParticipantCount) {
    throw new DebateRoomBuildFailure(
      `debate-room: registry has only ${primaryAgents.length} non-verifier personas, ` +
        `cannot honour requested ${directive.requestedPrimaryParticipantCount} primary participants. ` +
        `Configure additional personas in vinyan.json or reduce the count in your prompt.`,
      primaryAgents.length,
      directive.requestedPrimaryParticipantCount,
    );
  }

  const overlays = opts.personaOverlays ?? new Map<string, string>();
  const primaryRoles: RoleSpec[] = primaryAgents.map((agent) =>
    buildPrimaryRole(agent, directive.rebuttalRounds, overlays.get(agent.id)),
  );
  const roles: RoleSpec[] = [...primaryRoles];

  let oversightId: PersonaId | null = null;
  if (directive.reviewerPolicy === 'explicit') {
    const reviewer = registry.findCanonicalVerifier();
    const pid = reviewer ? tryAsPersonaId(reviewer.id) : undefined;
    if (reviewer && pid) {
      oversightId = pid;
      roles.push(buildOversightRole(reviewer, pid, directive.rebuttalRounds));
    }
    // When reviewerPolicy is 'explicit' but the registry has no verifier
    // persona, we silently downgrade to no-oversight rather than throwing.
    // The user explicitly asked for a reviewer; emitting an honest "no
    // verifier configured" warning is the runner's job (it has the bus).
  }

  let integratorId: PersonaId | null = null;
  if (directive.interactionMode !== 'parallel-answer') {
    // Preference order: caller-supplied (LLM-selected) → 'coordinator' →
    // registry.defaultAgent(). Every step is validated against the registry
    // so an LLM that suggested a stale id silently falls back to the
    // default rather than misattributing the synthesizer.
    let integratorAgent =
      opts.preferredIntegratorId !== undefined ? (registry.getAgent(opts.preferredIntegratorId) ?? null) : null;
    if (!integratorAgent) {
      integratorAgent = registry.getAgent(DEFAULT_INTEGRATOR_PERSONA_ID) ?? registry.defaultAgent();
    }
    const pid = tryAsPersonaId(integratorAgent.id);
    if (pid) {
      integratorId = pid;
      roles.push(buildIntegratorRole(integratorAgent, pid, overlays.get(integratorAgent.id)));
    }
  }

  const primaryRounds = 1 + directive.rebuttalRounds;
  const hasIntegrator = integratorId !== null;
  // Total rounds: every primary speaks `primaryRounds` times (initial +
  // rebuttal). The integrator runs ONCE on a dedicated final round so it
  // can read every primary's last turn before synthesizing.
  const maxRounds = primaryRounds + (hasIntegrator ? 1 : 0);

  // Token budget = total expected turns × per-turn estimate. Oversight
  // (when present) acts every primary round so it sees prior content
  // unfold; integrator acts once. Includes generous headroom via the
  // per-turn estimate; the supervisor's `tokensConsumed > tokenBudget`
  // gate enforces the cap as a hard upper bound.
  const perTurn = opts.perTurnTokenBudget ?? PER_TURN_TOKEN_BUDGET;
  const totalTurns = primaryAgents.length * primaryRounds + (oversightId ? primaryRounds : 0) + (hasIntegrator ? 1 : 0);
  const tokenBudget = totalTurns * perTurn;

  const contract: RoomContract = {
    roomId: `collab-${opts.parentTaskId}`,
    parentTaskId: opts.parentTaskId,
    goal: opts.goal,
    roles,
    maxRounds,
    minRounds: 0,
    convergenceThreshold: TEXT_ANSWER_CONVERGENCE_THRESHOLD,
    tokenBudget,
    outputMode: 'text-answer',
    rebuttalRounds: directive.rebuttalRounds,
  };

  const primaryParticipantIds = primaryAgents
    .map((a) => tryAsPersonaId(a.id))
    .filter((p): p is PersonaId => p !== undefined);

  return {
    contract,
    primaryParticipantIds,
    oversightParticipantId: oversightId,
    integratorParticipantId: integratorId,
  };
}

/**
 * Pick `n` agents to serve as primary participants.
 *
 * Two paths:
 *   1. **Caller-supplied** — when `preferredIds` is provided AND every id
 *      resolves to a registered agent AND the resolved set has size `n`,
 *      use it verbatim. Order is preserved (the LLM-selector already
 *      ordered them). Coordinator/reviewer slipping through the
 *      caller-supplied path are still allowed at this layer because the
 *      selector itself is responsible for the A1 reservation gate (see
 *      `llm-persona-selector.ts:PRIMARY_SLOT_BLOCKLIST`); this function
 *      only validates "do these ids exist".
 *   2. **Alphabetical fallback** — generator-class first (developer,
 *      architect, author, researcher), then mixed-class (mentor,
 *      assistant, concierge — but NEVER `coordinator`, which is reserved
 *      for the integrator role). Verifier-class personas (`reviewer`) are
 *      skipped: the user explicitly asked for primary participants, not
 *      reviewers, and conflating the two would weaken A1 even when no
 *      formal verification step is configured.
 *
 * Returns up to `n` distinct agents. May return fewer when the fallback
 * registry has too few eligible personas; the caller (the preset entry
 * point) raises `DebateRoomBuildFailure` when this happens so the runner
 * can surface an honest error.
 */
function selectPrimaryAgents(allAgents: AgentSpec[], n: number, preferredIds?: readonly PersonaId[]): AgentSpec[] {
  if (preferredIds && preferredIds.length === n) {
    const byId = new Map(allAgents.map((a) => [a.id, a]));
    const resolved: AgentSpec[] = [];
    const seen = new Set<string>();
    let allValid = true;
    for (const id of preferredIds) {
      if (seen.has(id)) {
        allValid = false;
        break;
      }
      const agent = byId.get(id);
      if (!agent) {
        allValid = false;
        break;
      }
      seen.add(id);
      resolved.push(agent);
    }
    if (allValid && resolved.length === n) return resolved;
    // Any validation failure → fall through to alphabetical (caller still
    // gets honest output rather than a misattributed mix of LLM choice +
    // alphabetical fill).
  }

  // Sort each pool alphabetically first, then concat — that way generators
  // ALWAYS precede mixed-class fallbacks regardless of overall id order.
  // Sorting the combined list mixes the two pools (e.g. `assistant` would
  // sort before `author` and a 3-pick would silently drop `researcher` in
  // favour of a mixed-class persona).
  const generators = allAgents
    .filter((a) => personaClassOf(a.role) === 'generator')
    .sort((a, b) => a.id.localeCompare(b.id));
  const mixedExceptCoordinator = allAgents
    .filter((a) => personaClassOf(a.role) === 'mixed' && a.id !== DEFAULT_INTEGRATOR_PERSONA_ID)
    .sort((a, b) => a.id.localeCompare(b.id));
  return [...generators, ...mixedExceptCoordinator].slice(0, n);
}

function buildPrimaryRole(agent: AgentSpec, rebuttalRounds: number, overlay: string | undefined): RoleSpec {
  const personaId = tryAsPersonaId(agent.id);
  const baseResponsibility =
    `You are the **${agent.name}** primary participant. Answer the user's goal directly. ` +
    `On rebuttal rounds you will see peers' prior answers — refine, rebut, or strengthen ` +
    `your stance. Do NOT simply repeat your prior turn.`;
  // Phase D — append the goal-specific overlay if the selector drafted
  // one for this persona. The overlay is 1-3 sentences guiding the
  // angle / framing for THIS goal; it does not replace the persona's
  // stock identity (registered soul stays intact).
  const responsibility = overlay
    ? `${baseResponsibility}\n\nFor THIS goal specifically:\n${overlay.trim()}`
    : baseResponsibility;
  return {
    name: agent.id,
    responsibility,
    // `discussion/...` carries the participant's per-round answer; the
    // `clarification/...` scope is needed for the Phase 4 clarification
    // bubble-up — the runner writes the user's answer back into the
    // participant's own namespace before re-dispatching the resumed turn.
    writableBlackboardKeys: [`discussion/${agent.id}/*`, `clarification/${agent.id}/*`],
    maxTurns: 1 + rebuttalRounds,
    canWriteFiles: false,
    roleClass: 'primary-participant',
    ...(personaId ? { personaId } : {}),
  };
}

function buildOversightRole(agent: AgentSpec, personaId: PersonaId, rebuttalRounds: number): RoleSpec {
  return {
    name: agent.id,
    responsibility:
      `You are the **${agent.name}** oversight reviewer. Read every primary participant's ` +
      `answer each round and flag concerns about feasibility, missing trade-offs, or hidden ` +
      `risks. You may NOT propose alternative answers — the primaries own the content.`,
    writableBlackboardKeys: [`oversight/${agent.id}/*`],
    maxTurns: 1 + rebuttalRounds,
    canWriteFiles: false,
    roleClass: 'oversight',
    personaId,
  };
}

function buildIntegratorRole(agent: AgentSpec, personaId: PersonaId, overlay: string | undefined): RoleSpec {
  const baseResponsibility =
    `Synthesize a single coherent final answer from all primary participants' transcripts. ` +
    `Honour distinct stances; surface meaningful disagreements rather than smoothing them over. ` +
    `When the directive carries a competition signal, end the response with the verdict block ` +
    `the user prompt requested.`;
  const responsibility = overlay
    ? `${baseResponsibility}\n\nFor THIS goal specifically:\n${overlay.trim()}`
    : baseResponsibility;
  return {
    name: agent.id,
    responsibility,
    writableBlackboardKeys: ['final/*'],
    maxTurns: 1,
    canWriteFiles: false,
    roleClass: 'integrator',
    personaId,
  };
}

/** Exposed for test assertions and downstream reuse. */
export const DEBATE_ROOM_DEFAULTS = {
  PER_TURN_TOKEN_BUDGET,
  DEFAULT_INTEGRATOR_PERSONA_ID,
  TEXT_ANSWER_CONVERGENCE_THRESHOLD,
} as const;
