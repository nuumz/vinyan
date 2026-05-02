/**
 * LLM-driven persona selector for multi-agent collaboration.
 *
 * Replaces the alphabetical-by-class selection in `selectPrimaryAgents`
 * with a content-aware LLM call. The goal text and the available roster
 * are read together so a code-architecture goal picks developer/architect/
 * reviewer-style mixes, a creative-writing goal picks author/mentor, and
 * a philosophy goal picks researcher/mentor — instead of always returning
 * `architect, author, developer` for every 3-agent request (alphabetical
 * artefact of the legacy generator-class slice).
 *
 * Best-effort contract. Returns `null` on any failure path (no provider,
 * LLM rejection, parse error, validation failure). The caller
 * (`workflow-planner`) treats `null` as "fall back to deterministic
 * alphabetical selection in `buildDebateRoomContract`" — the existing
 * green path is preserved unchanged.
 *
 * Validation enforced AFTER the LLM call (defense in depth):
 *   - count matches `directive.requestedPrimaryParticipantCount` exactly
 *   - every id appears verbatim in the registry
 *   - no duplicates in `primaryPersonaIds`
 *   - `'reviewer'` is rejected as primary (A1 reservation — see
 *     `debate-room.ts:selectPrimaryAgents` rationale)
 *   - `'coordinator'` is rejected as primary (reserved for integrator)
 *   - integrator (when supplied) exists in registry AND is not in primaries
 *
 * A3 compliant: the LLM result feeds into deterministic plan construction
 * but does NOT enter the governance/routing path itself. The selector is
 * an INPUT to `buildDebateRoomContract`, which still performs the same
 * structural checks (token budget, role spec, contract shape) on whatever
 * personas were chosen.
 */
import { z } from 'zod/v4';
import { type PersonaId, tryAsPersonaId } from '../../../core/agent-vocabulary.ts';
import type { AgentRegistry } from '../../agents/registry.ts';
import type { CollaborationDirective } from '../../intent/collaboration-parser.ts';
import { frozenSystemTier } from '../../llm/prompt-assembler.ts';
import type { LLMProviderRegistry } from '../../llm/provider-registry.ts';

/**
 * IDs the selector refuses to assign to a primary slot, regardless of LLM
 * preference. Mirrors the constraints documented in
 * `debate-room.ts:selectPrimaryAgents`.
 */
const PRIMARY_SLOT_BLOCKLIST: ReadonlyArray<string> = ['reviewer', 'coordinator'];

/** Max LLM attempts before falling back to alphabetical. */
const MAX_SELECTOR_ATTEMPTS = 2;

/** Conservative output budget — JSON list of ids + one-line rationale. */
const SELECTOR_MAX_TOKENS = 600;

const SelectionSchema = z.object({
  primaryPersonaIds: z.array(z.string().min(1)).min(1),
  integratorPersonaId: z.string().min(1).optional(),
  rationale: z.string().optional(),
});

const SYSTEM_PROMPT = `You are selecting personas for a multi-agent collaboration in the Vinyan orchestrator.

Inputs you receive:
  - The user's goal text (the question or task the participants will answer).
  - An interaction mode: parallel-answer | competition | debate | comparison.
  - A required count N of primary participants.
  - A roster of registered personas (id, role, description).

Pick exactly N distinct primary personas plus ONE integrator who synthesizes
the final answer. Your selection must:

  1. Match the goal's domain. developer/architect for code or system design;
     author for prose, fiction, or narrative; researcher for open inquiry,
     research questions, or exploratory analysis; mentor for explanatory or
     teaching-style prompts; assistant/concierge for general or light-touch
     help. If the goal is broad/philosophical, mix classes for diverse
     perspectives.

  2. Produce meaningful diversity. DO NOT pick three personas of the same
     role-class for a debate or competition — different angles produce a
     better collaboration. parallel-answer / comparison can tolerate more
     redundancy when justified by the goal.

  3. Suit the interaction mode. debate / competition wants personas that
     can productively disagree; parallel-answer / comparison can be more
     redundant.

Hard constraints (the orchestrator validates these and rejects bad output):
  - primaryPersonaIds.length MUST equal the requested count exactly.
  - Every id MUST appear verbatim in the roster.
  - No duplicates within primaryPersonaIds.
  - DO NOT include the integrator in primaryPersonaIds.
  - DO NOT use 'reviewer' as a primary (reserved for A1 oversight).
  - DO NOT use 'coordinator' as a primary (reserved for the integrator slot).
  - Default integrator preference: 'coordinator' when present in the roster.
    Pick a different mixed-class persona only when 'coordinator' is absent
    or the goal explicitly calls for a different synthesizer.

Output ONLY this JSON (no fences, no prose):
{
  "primaryPersonaIds": ["id1", "id2", ...],
  "integratorPersonaId": "<persona id who synthesizes>",
  "rationale": "one short sentence explaining the picks"
}`;

export interface PersonaSelectionResult {
  primaryIds: PersonaId[];
  integratorId?: PersonaId;
  rationale?: string;
  attempts: number;
}

export interface PersonaSelectionOpts {
  goal: string;
  directive: CollaborationDirective;
  registry: AgentRegistry;
  llmRegistry: LLMProviderRegistry;
}

/**
 * Returns null on any failure (no provider, LLM error, parse error,
 * validation failure). Caller falls back to deterministic alphabetical
 * selection in `buildDebateRoomContract`.
 *
 * Provider preference: 'fast' tier first, then 'balanced'. Persona
 * selection is a structural decision — small input, small output, no
 * deep reasoning required — so the fast tier is the right default cost
 * point.
 */
export async function selectPersonasViaLLM(opts: PersonaSelectionOpts): Promise<PersonaSelectionResult | null> {
  const provider = opts.llmRegistry.selectByTier('fast') ?? opts.llmRegistry.selectByTier('balanced');
  if (!provider) return null;

  const agents = opts.registry.listAgents();
  if (agents.length === 0) return null;

  const knownIds = new Set(agents.map((a) => a.id));
  if (!hasEnoughEligibleAgents(knownIds, opts.directive.requestedPrimaryParticipantCount)) {
    // Registry too small — even a perfect LLM answer cannot satisfy the
    // count once the blocklist is applied. Bail out so the caller hits
    // `DebateRoomBuildFailure` via the deterministic path and surfaces a
    // single honest single-agent fallback plan instead of looping the
    // selector.
    return null;
  }

  const roster = formatRoster(agents);
  const userPrompt = buildUserPrompt(opts, roster);

  for (let attempt = 1; attempt <= MAX_SELECTOR_ATTEMPTS; attempt++) {
    try {
      const response = await provider.generate({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt,
        maxTokens: SELECTOR_MAX_TOKENS,
        tiers: frozenSystemTier(SYSTEM_PROMPT, userPrompt),
      });

      const validated = parseSelectorResponse(response.content);
      if (!validated) continue;

      const result = validateSelection(validated, opts.directive, knownIds);
      if (result) return { ...result, attempts: attempt };
    } catch {
      // retry on parse / network / provider error
    }
  }
  return null;
}

function hasEnoughEligibleAgents(knownIds: Set<string>, requestedCount: number): boolean {
  const eligibleCount = [...knownIds].filter((id) => !PRIMARY_SLOT_BLOCKLIST.includes(id)).length;
  return eligibleCount >= requestedCount;
}

function formatRoster(agents: ReturnType<AgentRegistry['listAgents']>): string {
  return agents
    .map((a) => {
      const role = a.role ?? '(no role)';
      const description = a.description ?? '(no description)';
      return `  - ${a.id} (role=${role}): ${description}`;
    })
    .join('\n');
}

function buildUserPrompt(opts: PersonaSelectionOpts, roster: string): string {
  const { directive, goal } = opts;
  return [
    `Goal: ${goal}`,
    '',
    `Interaction mode: ${directive.interactionMode}`,
    `Required primary count: ${directive.requestedPrimaryParticipantCount}`,
    `Rebuttal rounds: ${directive.rebuttalRounds}`,
    `Reviewer policy: ${directive.reviewerPolicy}`,
    '',
    'Roster:',
    roster,
    '',
    `Pick exactly ${directive.requestedPrimaryParticipantCount} primary persona ids that best match the goal's domain plus one integrator id. Output JSON only.`,
  ].join('\n');
}

/** Strip optional fences and parse against the Zod schema. Returns null on failure. */
function parseSelectorResponse(content: string): z.infer<typeof SelectionSchema> | null {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  try {
    const parsed = JSON.parse(cleaned);
    return SelectionSchema.parse(parsed);
  } catch {
    return null;
  }
}

/**
 * Validate the LLM's selection against the registry + directive. Returns
 * the branded result on success, null on any constraint violation.
 *
 * Constraints (any failure → null, caller retries or falls back):
 *   - primaryPersonaIds.length === directive.requestedPrimaryParticipantCount
 *   - every primary id is in `knownIds` AND not on `PRIMARY_SLOT_BLOCKLIST`
 *   - primary ids are unique
 *   - integrator (if given) is in `knownIds` AND not in primary set
 */
function validateSelection(
  validated: z.infer<typeof SelectionSchema>,
  directive: CollaborationDirective,
  knownIds: Set<string>,
): Omit<PersonaSelectionResult, 'attempts'> | null {
  const wantCount = directive.requestedPrimaryParticipantCount;
  if (validated.primaryPersonaIds.length !== wantCount) return null;

  const seen = new Set<string>();
  const primaries: PersonaId[] = [];
  for (const id of validated.primaryPersonaIds) {
    if (!knownIds.has(id)) return null;
    if (PRIMARY_SLOT_BLOCKLIST.includes(id)) return null;
    if (seen.has(id)) return null;
    const branded = tryAsPersonaId(id);
    if (!branded) return null;
    seen.add(id);
    primaries.push(branded);
  }

  let integratorId: PersonaId | undefined;
  if (validated.integratorPersonaId) {
    const candidate = validated.integratorPersonaId;
    if (knownIds.has(candidate) && !seen.has(candidate)) {
      const branded = tryAsPersonaId(candidate);
      if (branded) integratorId = branded;
    }
  }

  return {
    primaryIds: primaries,
    ...(integratorId ? { integratorId } : {}),
    ...(validated.rationale ? { rationale: validated.rationale } : {}),
  };
}

export const PERSONA_SELECTOR_LIMITS = {
  MAX_SELECTOR_ATTEMPTS,
  SELECTOR_MAX_TOKENS,
  PRIMARY_SLOT_BLOCKLIST,
} as const;
