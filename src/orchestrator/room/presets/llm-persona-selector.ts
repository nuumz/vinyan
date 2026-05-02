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
  // Accept omitted, explicit null, OR a non-empty string id. Parallel-answer
  // mode does not run an integrator, and the LLM is told to set null in
  // that case — both null and undefined collapse to "no integrator".
  integratorPersonaId: z.string().min(1).nullable().optional(),
  rationale: z.string().optional(),
});

const SYSTEM_PROMPT = `You are selecting personas for a multi-agent collaboration in the Vinyan orchestrator.

Inputs you receive:
  - The user's goal text (the question or task the participants will answer).
  - An interaction mode: parallel-answer | competition | debate | comparison.
  - A required count N of primary participants.
  - A roster of registered personas (id, role, description).

Pick exactly N distinct primary personas plus ONE integrator who synthesizes
the final answer.

PRIMARY SELECTION rules:

  1. Match the goal's domain. developer/architect for code or system design;
     author for prose, fiction, or narrative; researcher for open inquiry,
     research questions, or exploratory analysis; mentor for explanatory or
     teaching-style prompts; assistant/concierge for general, light-touch,
     or logistics-style help. If the goal is broad/philosophical, mix
     classes for diverse perspectives.

  2. Produce meaningful diversity. DO NOT pick three personas of the same
     role-class for a debate or competition — different angles produce a
     better collaboration. parallel-answer / comparison can tolerate more
     redundancy when justified by the goal.

  3. Suit the interaction mode. debate / competition wants personas that
     can productively disagree; parallel-answer / comparison can be more
     redundant.

INTEGRATOR SELECTION rules (the synthesizer who reads every primary's
answer and produces the final reply to the user):

  - 'coordinator' is the GENERAL DEFAULT — pick it for cross-domain or
    routing-style synthesis where no single persona fits better.
  - 'mentor' fits decision-support, coaching, or long-form advisory goals
    where the final answer should help the user think through trade-offs
    (e.g. health management plans, career advice, architectural decisions
    that need to be justified to humans).
  - 'reviewer' fits goals whose synthesis is a verdict / sign-off / audit
    (e.g. "review three refactor strategies and pick the safest", code or
    document review). Reviewer is forbidden as a PRIMARY but ALLOWED as
    the integrator when the final reply is structurally a verdict.
  - 'assistant' fits short-summary or quick-recommendation goals where the
    final reply is a tight answer rather than a guided explanation.
  - 'concierge' fits logistics-heavy goals (schedules, travel, planning)
    where the final answer is a curated action list.
  - 'author' fits goals whose final reply is itself a single coherent
    prose artefact (long-form story, article, essay) — author both
    integrates AND polishes.

  Pick the integrator that BEST matches the goal — don't default to
  'coordinator' when another persona is a clearer fit. But also don't
  reach for an exotic integrator without justification: 'coordinator'
  is always a safe choice when the goal doesn't strongly suggest
  another synthesizer.

CRITICAL — disjoint primary vs. integrator. The integrator MUST NOT
appear in primaryPersonaIds. The orchestrator silently DROPS an
integrator that overlaps any primary and falls back to 'coordinator',
losing your synthesis preference. Produce a clean, disjoint pair.

Worked examples (prose goal — "write a fairy tale, parallel-answer, count=3"):
  - WRONG  primaries=[author,author,author], integrator=author
            (duplicate primaries AND overlap with integrator)
  - WRONG  primaries=[author,researcher,mentor], integrator=author
            (integrator overlaps primary[0]; orchestrator will fallback)
  - RIGHT  primaries=[author,researcher,mentor], integrator=coordinator
            (author drives prose as a primary; coordinator wraps the voices)
  - RIGHT  primaries=[researcher,mentor,assistant], integrator=author
            (author polishes the final prose artefact; primaries supply
             world-building, age-appropriateness, and creative spark)

Rule of thumb when a single persona feels right for both slots:
  - If the persona's main contribution is GENERATING content along one
    angle, put it in primaries and pick a synthesizer (coordinator,
    mentor, reviewer) as integrator.
  - If the persona's main contribution is POLISHING / VERIFYING the
    combined output, put it in the integrator slot and replace the
    primary slot it would have taken with a sibling persona.

Hard constraints (the orchestrator validates these and rejects bad output):
  - primaryPersonaIds.length MUST equal the requested count exactly.
  - Every id MUST appear verbatim in the roster.
  - No duplicates within primaryPersonaIds.
  - integratorPersonaId MUST NOT equal any id in primaryPersonaIds.
  - DO NOT use 'reviewer' as a primary (reserved for A1 oversight; it
    MAY appear as the integrator).
  - DO NOT use 'coordinator' as a primary (reserved for the integrator slot).

Output ONLY this JSON (no fences, no prose):
{
  "primaryPersonaIds": ["id1", "id2", ...],
  "integratorPersonaId": "<persona id who synthesizes>",
  "rationale": "one short sentence explaining the primary + integrator picks"
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
  // Tier order: balanced FIRST, then fast. Persona selection is small but
  // structurally rich — the LLM has to read the full roster, the goal, the
  // interaction mode, and the disjoint primary/integrator constraint, then
  // produce JSON whose IDs hit a precise validation gate. The 26B "fast"
  // tier (Gemma) was observed to fail the disjoint constraint on prose
  // goals roughly 1/6 trials in `scripts/experiment-persona-selector.ts`,
  // while the 31B "balanced" tier honoured it consistently. Selection
  // latency is identical to within 1s; the cost premium is negligible
  // against a multi-LLM-call collaboration plan.
  const provider = opts.llmRegistry.selectByTier('balanced') ?? opts.llmRegistry.selectByTier('fast');
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
  // Best soft-pass kept across attempts so a stubborn LLM that keeps
  // emitting an integrator overlap on every retry still leaves us with a
  // content-aware primary set + a graceful integrator drop instead of a
  // null fallback to the alphabetical path. The primaries on the soft
  // path are content-aware; only the integrator slot loses the LLM's
  // preference and falls back to the registry default in
  // `buildDebateRoomContract`.
  let bestSoftPass: { value: Omit<PersonaSelectionResult, 'attempts'>; attempt: number } | null = null;
  let lastError: string | undefined;

  for (let attempt = 1; attempt <= MAX_SELECTOR_ATTEMPTS; attempt++) {
    const userPrompt = buildUserPrompt(opts, roster, lastError);
    try {
      const response = await provider.generate({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt,
        maxTokens: SELECTOR_MAX_TOKENS,
        tiers: frozenSystemTier(SYSTEM_PROMPT, userPrompt),
      });

      const validated = parseSelectorResponse(response.content);
      if (!validated) {
        lastError =
          'Your previous response was not valid JSON matching the schema. Output ONLY the JSON object — no fences, no explanatory prose around it.';
        continue;
      }

      const outcome = validateSelection(validated, opts.directive, knownIds);
      if (outcome.kind === 'pass') {
        return { ...outcome.value, attempts: attempt };
      }
      if (outcome.kind === 'soft-pass') {
        // Primaries are valid but integrator was rejected. Keep this as
        // a fallback (best soft pass — first one wins; later soft-passes
        // are no better) and retry with explicit feedback so the LLM
        // gets a chance to fix the overlap.
        if (!bestSoftPass) bestSoftPass = { value: outcome.value, attempt };
        lastError = outcome.error;
        continue;
      }
      // hard fail — keep retrying with feedback
      lastError = outcome.error;
    } catch (err) {
      lastError = `provider call failed: ${err instanceof Error ? err.message : String(err)}. Retry with the same task.`;
    }
  }

  if (bestSoftPass) return { ...bestSoftPass.value, attempts: bestSoftPass.attempt };
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

function buildUserPrompt(opts: PersonaSelectionOpts, roster: string, lastError?: string): string {
  const { directive, goal } = opts;
  const isParallel = directive.interactionMode === 'parallel-answer';
  const integratorInstr = isParallel
    ? `Pick exactly ${directive.requestedPrimaryParticipantCount} primary persona ids that best match the goal's domain. interactionMode='parallel-answer' DOES NOT RUN AN INTEGRATOR — set integratorPersonaId to null. Output JSON only.`
    : `Pick exactly ${directive.requestedPrimaryParticipantCount} primary persona ids that best match the goal's domain plus one integrator id. Output JSON only.`;
  const lines: string[] = [
    `Goal: ${goal}`,
    '',
    `Interaction mode: ${directive.interactionMode}${isParallel ? ' (NO integrator runs in this mode)' : ''}`,
    `Required primary count: ${directive.requestedPrimaryParticipantCount}`,
    `Rebuttal rounds: ${directive.rebuttalRounds}`,
    `Reviewer policy: ${directive.reviewerPolicy}`,
    '',
    'Roster:',
    roster,
    '',
    integratorInstr,
  ];
  if (lastError) {
    lines.push('');
    lines.push('--- RETRY FEEDBACK ---');
    lines.push(`Previous attempt was rejected: ${lastError}`);
    lines.push(
      'Re-read the constraints carefully. The integrator MUST be a different id from every entry in primaryPersonaIds. If the persona that fits the integrator role best is also a strong primary candidate, EITHER (a) keep it as a primary and pick a synthesizer (coordinator/mentor/reviewer) as integrator, OR (b) put it in the integrator slot and replace the freed primary with a sibling persona. DO NOT submit the same overlapping selection again.',
    );
  }
  return lines.join('\n');
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
 * Validation outcome with three discriminants so the caller can:
 *   - `pass`      — accept the result immediately
 *   - `soft-pass` — primaries are valid but integrator must be dropped
 *                   (overlap or unknown id). Keep as fallback; retry to
 *                   try for a strict pass with explicit feedback.
 *   - `fail`      — primaries themselves are invalid (count mismatch,
 *                   unknown id, blocklisted, duplicate). Retry with
 *                   feedback; fall through to caller alphabetical path
 *                   if every attempt hard-fails.
 */
type ValidationOutcome =
  | { kind: 'pass'; value: Omit<PersonaSelectionResult, 'attempts'> }
  | { kind: 'soft-pass'; value: Omit<PersonaSelectionResult, 'attempts'>; error: string }
  | { kind: 'fail'; error: string };

/**
 * Validate the LLM's selection against the registry + directive.
 *
 * Constraints (any primary-side failure → `'fail'`):
 *   - primaryPersonaIds.length === directive.requestedPrimaryParticipantCount
 *   - every primary id is in `knownIds` AND not on `PRIMARY_SLOT_BLOCKLIST`
 *   - primary ids are unique
 *
 * Integrator soft-failures (→ `'soft-pass'`, integrator omitted from value):
 *   - integratorPersonaId not in `knownIds` (LLM hallucinated)
 *   - integratorPersonaId equals one of primaryPersonaIds (overlap)
 *
 * The discriminated union lets the main loop keep a soft-pass as a
 * graceful fallback while retrying for a strict pass.
 */
function validateSelection(
  validated: z.infer<typeof SelectionSchema>,
  directive: CollaborationDirective,
  knownIds: Set<string>,
): ValidationOutcome {
  const wantCount = directive.requestedPrimaryParticipantCount;
  if (validated.primaryPersonaIds.length !== wantCount) {
    return {
      kind: 'fail',
      error: `primaryPersonaIds had ${validated.primaryPersonaIds.length} ids; required exactly ${wantCount}.`,
    };
  }

  const seen = new Set<string>();
  const primaries: PersonaId[] = [];
  for (const id of validated.primaryPersonaIds) {
    if (!knownIds.has(id)) {
      return { kind: 'fail', error: `primary id "${id}" is not in the roster — pick from the listed ids verbatim.` };
    }
    if (PRIMARY_SLOT_BLOCKLIST.includes(id)) {
      return {
        kind: 'fail',
        error: `primary id "${id}" is reserved (reviewer/coordinator may not appear in primaryPersonaIds).`,
      };
    }
    if (seen.has(id)) {
      return {
        kind: 'fail',
        error: `primary id "${id}" appeared twice in primaryPersonaIds — every primary must be a distinct persona.`,
      };
    }
    const branded = tryAsPersonaId(id);
    if (!branded) {
      return { kind: 'fail', error: `primary id "${id}" failed branded-id shape check.` };
    }
    seen.add(id);
    primaries.push(branded);
  }

  const baseValue = {
    primaryIds: primaries,
    ...(validated.rationale ? { rationale: validated.rationale } : {}),
  };

  // parallel-answer mode does NOT run an integrator (see
  // `debate-room.ts`'s `if (directive.interactionMode !== 'parallel-answer')`
  // guard). The selector accepts an integrator pick from the LLM but DOES
  // NOT carry it into the result for this mode — the value would be
  // silently ignored by `buildDebateRoomContract` anyway, so surfacing it
  // would only mislead the caller / dashboards. Skip integrator validation
  // entirely here so the LLM's "null" response is a clean strict pass.
  if (directive.interactionMode === 'parallel-answer') {
    return { kind: 'pass', value: baseValue };
  }

  if (!validated.integratorPersonaId) {
    // Integrator was optional; treat absence as a soft pass so the caller
    // can decide whether the registry default (coordinator) is acceptable
    // OR retry to demand an explicit pick.
    return {
      kind: 'soft-pass',
      value: baseValue,
      error: 'integratorPersonaId was missing — add an explicit integrator id (different from every primary).',
    };
  }

  const candidate = validated.integratorPersonaId;
  if (!knownIds.has(candidate)) {
    return {
      kind: 'soft-pass',
      value: baseValue,
      error: `integratorPersonaId "${candidate}" is not in the roster — pick from the listed ids verbatim.`,
    };
  }
  if (seen.has(candidate)) {
    return {
      kind: 'soft-pass',
      value: baseValue,
      error: `integratorPersonaId "${candidate}" overlaps with primaryPersonaIds — pick a DIFFERENT integrator id, OR replace the overlapping primary with another persona and keep "${candidate}" as the integrator.`,
    };
  }
  const branded = tryAsPersonaId(candidate);
  if (!branded) {
    return {
      kind: 'soft-pass',
      value: baseValue,
      error: `integratorPersonaId "${candidate}" failed branded-id shape check.`,
    };
  }

  return {
    kind: 'pass',
    value: { ...baseValue, integratorId: branded },
  };
}

export const PERSONA_SELECTOR_LIMITS = {
  MAX_SELECTOR_ATTEMPTS,
  SELECTOR_MAX_TOKENS,
  PRIMARY_SLOT_BLOCKLIST,
} as const;
