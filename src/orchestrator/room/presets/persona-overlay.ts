/**
 * Persona overlay — Phase D smart-creative-workflow refactor.
 *
 * The persona selector picks ids from the registry. For multi-agent
 * collaboration, simply rendering the persona's stock soul makes every
 * "3 agents debate" run produce three voices that converge — the souls
 * are designed for cross-domain reuse, not goal-specific differentiation.
 *
 * The OVERLAY is a small LLM-drafted addendum that gets concatenated to
 * the persona's room-role `responsibility` text:
 *
 *   - Voice / perspective angle (e.g. "argue from the worker-rights side"
 *     vs "argue from the corporate-ROI side")
 *   - Goal-specific framing ("anchor your answer in TikTok-2026 algorithm
 *     mechanics, not generic short-form best practice")
 *   - Tone hint that complements the assigned persona's class
 *
 * A1 / A3 contract:
 *   - The overlay drafter is an LLM call, BUT it lives in the selector
 *     module which is explicitly A3-orthogonal (per its own docstring).
 *     Routing / commit / verification decisions are still rule-based.
 *   - The overlay influences ONLY the role's `responsibility` text the
 *     debate-room dispatcher injects into each turn's prompt. It does
 *     NOT widen ACL, change capability scoring, or affect the Agent's
 *     soul as registered in the AgentRegistry.
 *   - Persona-class lint applies: a non-verifier persona's overlay must
 *     not contain first-person verification verbs.
 *
 * Best-effort: any failure (no provider, parse error, lint reject) returns
 * an empty map and the dispatcher uses the persona's stock responsibility.
 */

import { frozenSystemTier } from '../../llm/prompt-assembler.ts';
import type { LLMProviderRegistry } from '../../llm/provider-registry.ts';
import type { LLMProvider } from '../../types.ts';

/** Max LLM attempts before falling back to no-overlay. */
const MAX_OVERLAY_ATTEMPTS = 1;

/** Output budget — overlays are 1-3 sentences each, 5 personas max → tight cap. */
const OVERLAY_MAX_TOKENS = 600;

/** Wall-clock guard — overlay is best-effort; drop it if the provider stalls. */
const OVERLAY_TIMEOUT_MS = 8_000;

const VERIFY_VERB_PATTERN = /\bI (?:check|verify|review|audit|evaluate|validate|assess|critique)\b/i;

export interface PersonaOverlayDraftRequest {
  /** The user goal (drives goal-specific framing). */
  goal: string;
  /**
   * Persona ids that will participate as primaries. Order corresponds to
   * the order the orchestrator dispatched. The drafter generates one
   * overlay per id (skipping any that fail validation).
   */
  primaryIds: ReadonlyArray<string>;
  /** Optional integrator persona id; the drafter writes a synthesis-style overlay for it. */
  integratorId?: string;
  /**
   * Persona summary table — id → role (`generator|verifier|mixed`) +
   * one-line description from the registry. The overlay drafter uses
   * the role to apply the verifier-only verb lint and the description
   * to keep the overlay coherent with the persona's stated purpose.
   */
  personaInfo: ReadonlyArray<{
    id: string;
    role?: 'generator' | 'verifier' | 'mixed';
    description?: string;
  }>;
  /**
   * Coarse interaction mode — informs the drafter whether to write
   * overlays that PRODUCTIVELY DISAGREE (debate / competition) or
   * CONTRIBUTE-IN-PARALLEL (parallel-answer / comparison).
   */
  interactionMode: 'parallel-answer' | 'competition' | 'debate' | 'comparison';
  /** Optional creative-domain hint for tone-aligned overlay phrasing. */
  creativeDomain?: string;
  /** LLM provider registry — the drafter prefers fast tier. */
  llmRegistry: LLMProviderRegistry;
}

export interface PersonaOverlayDraftResult {
  /** Map keyed by persona id → overlay text (1-3 sentences). Missing ids = no overlay. */
  overlays: ReadonlyMap<string, string>;
  /** Free-form rationale for the chosen angles (observability only). */
  rationale?: string;
  attempts: number;
}

const SYSTEM_PROMPT = `You are a persona-overlay drafter for the Vinyan creative-content orchestrator.

Given a user goal + a set of primary personas + an interaction mode, write a SHORT (1-3 sentences) overlay per persona. The overlay will be concatenated to the persona's stock room-role responsibility text — it is NOT a replacement for the persona's identity, only an angle / framing for THIS specific goal.

OBJECTIVES:
  1. Each persona's overlay should describe a DISTINCT angle / perspective / hook.
     - For "debate" / "competition": angles must productively DISAGREE — pick contrasting framings the user benefits from seeing argued.
     - For "parallel-answer" / "comparison": angles can be complementary; describe what aspect each persona owns.
  2. Anchor the overlay in the user's goal — not generic best-practice prose.
  3. Voice / tone should complement the persona's stated role (a developer overlay can lean technical; an author overlay can lean narrative).

HARD RULES:
  - DO NOT write self-verification verbs ("I check", "I verify", "I review", "I audit", "I evaluate", "I validate", "I assess", "I critique") for personas whose role is NOT 'verifier'. The orchestrator rejects overlays containing these verbs in non-verifier slots.
  - DO NOT change persona ids — return overlays keyed by the EXACT id in the input array.
  - DO NOT exceed 3 sentences per overlay. Brevity > flair.
  - DO NOT invent ids the input did not list.

Output JSON only (no fences, no prose):
{
  "overlays": { "<personaId>": "<overlay text>", ... },
  "rationale": "one short sentence describing the overall angle distribution"
}

Keys must EXACTLY match ids in the input. Missing ids = no overlay (the orchestrator falls back to the persona's stock responsibility).`;

interface ParsedOverlayResponse {
  overlays?: Record<string, unknown>;
  rationale?: unknown;
}

export async function draftPersonaOverlay(req: PersonaOverlayDraftRequest): Promise<PersonaOverlayDraftResult> {
  const empty: PersonaOverlayDraftResult = { overlays: new Map(), attempts: 0 };
  if (req.primaryIds.length === 0) return empty;

  const provider: LLMProvider | undefined =
    req.llmRegistry.selectByTier('fast') ?? req.llmRegistry.selectByTier('balanced');
  if (!provider) return empty;

  const userPrompt = buildUserPrompt(req);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), OVERLAY_TIMEOUT_MS);

  try {
    for (let attempt = 1; attempt <= MAX_OVERLAY_ATTEMPTS; attempt++) {
      try {
        const response = await provider.generate({
          systemPrompt: SYSTEM_PROMPT,
          userPrompt,
          maxTokens: OVERLAY_MAX_TOKENS,
          temperature: 0,
          tiers: frozenSystemTier(SYSTEM_PROMPT, userPrompt),
        });
        const parsed = parseOverlayResponse(response.content);
        if (!parsed) continue;
        const overlays = validateOverlays(parsed, req.primaryIds, req.integratorId, req.personaInfo);
        if (overlays.size === 0) continue;
        return {
          overlays,
          ...(typeof parsed.rationale === 'string' ? { rationale: parsed.rationale } : {}),
          attempts: attempt,
        };
      } catch {
        // retry
      }
    }
    return empty;
  } finally {
    clearTimeout(timer);
  }
}

function buildUserPrompt(req: PersonaOverlayDraftRequest): string {
  const lines: string[] = [];
  lines.push(`Goal: ${req.goal}`);
  if (req.creativeDomain) lines.push(`Creative domain: ${req.creativeDomain}`);
  lines.push(`Interaction mode: ${req.interactionMode}`);
  lines.push('');
  lines.push('Primary personas (write one overlay per id):');
  for (const id of req.primaryIds) {
    const info = req.personaInfo.find((p) => p.id === id);
    const role = info?.role ?? 'mixed';
    const desc = info?.description ?? '';
    lines.push(`  - ${id}  (role=${role})${desc ? ` — ${desc.slice(0, 140)}` : ''}`);
  }
  if (req.integratorId) {
    const info = req.personaInfo.find((p) => p.id === req.integratorId);
    const role = info?.role ?? 'mixed';
    const desc = info?.description ?? '';
    lines.push('');
    lines.push('Integrator persona (write a synthesis-style overlay):');
    lines.push(`  - ${req.integratorId}  (role=${role})${desc ? ` — ${desc.slice(0, 140)}` : ''}`);
  }
  lines.push('');
  lines.push('Return JSON only. Each overlay 1-3 sentences max.');
  return lines.join('\n');
}

function parseOverlayResponse(content: string): ParsedOverlayResponse | null {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed as ParsedOverlayResponse;
  } catch {
    return null;
  }
}

function validateOverlays(
  parsed: ParsedOverlayResponse,
  primaryIds: ReadonlyArray<string>,
  integratorId: string | undefined,
  personaInfo: PersonaOverlayDraftRequest['personaInfo'],
): Map<string, string> {
  const out = new Map<string, string>();
  if (!parsed.overlays || typeof parsed.overlays !== 'object') return out;
  const knownIds = new Set<string>([...primaryIds, ...(integratorId ? [integratorId] : [])]);
  for (const [id, raw] of Object.entries(parsed.overlays)) {
    if (!knownIds.has(id)) continue;
    if (typeof raw !== 'string' || raw.trim().length === 0) continue;
    const text = raw.trim().slice(0, 600);
    // Persona-class lint: non-verifier personas may not use first-person
    // verification verbs in the overlay (mirrors the registry-level lint
    // on persona souls).
    const info = personaInfo.find((p) => p.id === id);
    const role = info?.role ?? 'mixed';
    if (role !== 'verifier' && VERIFY_VERB_PATTERN.test(text)) {
      // Drop with no in-place rewrite — the dispatcher uses the stock
      // responsibility text for this persona.
      continue;
    }
    out.set(id, text);
  }
  return out;
}

export const PERSONA_OVERLAY_LIMITS = {
  MAX_OVERLAY_ATTEMPTS,
  OVERLAY_MAX_TOKENS,
  OVERLAY_TIMEOUT_MS,
} as const;
