/**
 * Creative-Clarification Gate — Phase C smart-context refactor.
 *
 * When the intent resolver picks `agentic-workflow` for a long-form creative
 * goal (novel / webtoon / video / music / game / marketing / education /
 * business / visual / article) AND the session has no prior turns, we pause
 * and emit structured clarification questions so the user can anchor the
 * workflow before the planner burns tokens on a poorly-specified draft.
 *
 * Phase C extension: the gate now ALSO runs an LLM ranking pass that
 * annotates each option with `suggestedDefault`, `rationale`, and
 * (when a `ClarificationTrendProvider` is wired) `trendingHint`. The
 * ranker reads:
 *   - the deterministic templates (the option set),
 *   - the user-context snapshot from `UserInterestMiner`,
 *   - recent session turns,
 *   - the trend feed (optional).
 *
 * The ranker is best-effort: any failure (no LLM, parse error, validation
 * reject) collapses back to the unranked deterministic templates — same
 * shape as before, just without the smart annotations.
 *
 * A3 contract preserved:
 *   - The deterministic gate decision (does the goal call for a creative
 *     gate? do we skip on prior turns? do we skip on CLARIFICATION_BATCH?)
 *     remains rule-based.
 *   - The ranker is ADVISORY — it never changes the question set or the
 *     option ids, only re-orders + annotates. A failed ranker leaves the
 *     deterministic output intact.
 */

import type { SessionManager } from '../api/session-manager.ts';
import type { VinyanBus } from '../core/bus.ts';
import type { ClarificationOption, ClarificationQuestion } from '../core/clarification.ts';
import type { TraceCollector } from './core-loop.ts';
import { applyRoutingGovernance } from './governance-provenance.ts';
import { frozenSystemTier } from './llm/prompt-assembler.ts';
import type { LLMProviderRegistry } from './llm/provider-registry.ts';
import type { ExecutionTrace, RoutingDecision, TaskInput, TaskResult, Turn } from './types.ts';
import type { CreativeDomain } from './understanding/clarification-templates.ts';
import { buildClarificationSet, inferCreativeDomain } from './understanding/clarification-templates.ts';
import {
  type ClarificationTrendHintMap,
  type ClarificationTrendProvider,
  trendHintKey,
} from './user-context/trend-feed.ts';
import type { UserContextSnapshot } from './user-context/types.ts';
import type { UserInterestMiner } from './user-context/user-interest-miner.ts';

/**
 * Deps surface kept deliberately narrow so the gate can be unit-tested with
 * lightweight stubs instead of a full OrchestratorDeps.
 */
export interface CreativeClarificationGateDeps {
  bus?: VinyanBus;
  sessionManager?: Pick<SessionManager, 'getTurnsHistory'>;
  traceCollector: Pick<TraceCollector, 'record'>;
  /**
   * Phase C — optional smart-ranker dependencies. When all three are
   * present, the gate runs the LLM ranking pass and annotates options
   * with suggestedDefault / rationale / trendingHint. Any combination
   * of absent deps falls back to the deterministic template output.
   */
  llmRegistry?: LLMProviderRegistry;
  userInterestMiner?: UserInterestMiner;
  trendFeed?: ClarificationTrendProvider;
}

/** Output budget for the smart-ranker LLM call (deliberately tight). */
const RANKER_MAX_TOKENS = 800;
/** Single-attempt timeout for the ranker — we never block the gate on it. */
const RANKER_TIMEOUT_MS = 6_000;

/**
 * Run the gate. Returns a fully-formed `TaskResult` with `status: 'input-required'`
 * when the gate fires; returns `null` otherwise so callers fall through to the
 * regular dispatch path.
 */
export async function maybeEmitCreativeClarificationGate(
  input: TaskInput,
  routing: RoutingDecision,
  deps: CreativeClarificationGateDeps,
): Promise<TaskResult | null> {
  const creativeDomain = inferCreativeDomain(input.goal);
  if (creativeDomain === 'generic') return null;

  // Defense against the gate re-interrogating the user on every turn: when
  // the API handler (server.ts / chat.ts) has packed the prior questions +
  // user reply into a CLARIFICATION_BATCH constraint, this task IS the
  // clarification answer. Re-firing the gate would drop the reply and
  // re-send the same questions.
  if (input.constraints?.some((c) => c.startsWith('CLARIFICATION_BATCH:'))) return null;

  if (hasPriorSessionTurns(input.sessionId, deps.sessionManager)) return null;

  const baseQuestions = buildClarificationSet({ creativeDomain });
  if (baseQuestions.length === 0) return null;

  // Phase C — smart annotation pass. Best-effort; failures collapse back
  // to the deterministic template output without disrupting the gate's
  // primary contract (emit clarification → return input-required).
  const enriched = await enrichWithSmartContext({
    baseQuestions,
    goal: input.goal,
    creativeDomain,
    sessionId: input.sessionId,
    deps,
  });

  const stringQuestions = enriched.map((q) => q.prompt);

  const trace: ExecutionTrace = applyRoutingGovernance(
    {
      id: `trace-${input.id}-creative-clarify`,
      taskId: input.id,
      sessionId: input.sessionId,
      workerId: 'orchestrator',
      timestamp: Date.now(),
      routingLevel: routing.level,
      approach: 'creative-clarification',
      approachDescription: `Fresh ${creativeDomain} creative task — prompting user for genre/audience/tone/length/platform before dispatch.`,
      oracleVerdicts: {},
      modelUsed: 'none',
      tokensConsumed: 0,
      durationMs: 0,
      outcome: 'success',
      affectedFiles: input.targetFiles ?? [],
    },
    routing,
  );
  await deps.traceCollector.record(trace);
  deps.bus?.emit('trace:record', { trace });
  deps.bus?.emit('agent:clarification_requested', {
    taskId: input.id,
    sessionId: input.sessionId,
    questions: stringQuestions,
    structuredQuestions: enriched,
    routingLevel: routing.level,
    source: 'orchestrator',
  });

  const result: TaskResult = {
    id: input.id,
    status: 'input-required',
    mutations: [],
    trace,
    clarificationNeeded: stringQuestions,
  };
  deps.bus?.emit('task:complete', { result });
  return result;
}

// ── Phase C smart-ranker pipeline ────────────────────────────────────────

interface EnrichOpts {
  baseQuestions: ClarificationQuestion[];
  goal: string;
  creativeDomain: CreativeDomain;
  sessionId?: string;
  deps: CreativeClarificationGateDeps;
}

/**
 * Wraps the deterministic template output with smart annotations. The
 * function is failure-tolerant: any internal error returns the base
 * questions unchanged so the gate's user-facing contract remains stable.
 */
async function enrichWithSmartContext(opts: EnrichOpts): Promise<ClarificationQuestion[]> {
  const { baseQuestions, deps } = opts;
  if (!deps.llmRegistry) return baseQuestions;

  // Snapshot user interest first — even an empty snapshot is useful for
  // the ranker to know "I have no history". A failed mine call → drop
  // straight to baseQuestions; we don't try to be clever.
  let snapshot: UserContextSnapshot | undefined;
  if (deps.userInterestMiner) {
    try {
      snapshot = deps.userInterestMiner.mine();
    } catch {
      snapshot = undefined;
    }
  }

  // Recent session turns — capped at 4 so the ranker prompt stays tight.
  let recentTurns: Turn[] = [];
  if (opts.sessionId && deps.sessionManager) {
    try {
      const sm = deps.sessionManager as unknown as {
        getTurnsHistory?: (id: string, n?: number) => Turn[];
      };
      recentTurns = sm.getTurnsHistory?.(opts.sessionId, 4) ?? [];
    } catch {
      recentTurns = [];
    }
  }

  // Trend hints — provider may be the NULL provider (returns empty Map).
  let trendHints: ClarificationTrendHintMap = new Map();
  if (deps.trendFeed) {
    try {
      const fetched = await Promise.resolve(
        deps.trendFeed.fetch({
          creativeDomain: opts.creativeDomain,
          goal: opts.goal,
        }),
      );
      trendHints = fetched ?? new Map();
    } catch {
      trendHints = new Map();
    }
  }

  // Single fast-tier LLM call. The ranker returns annotations keyed by
  // (questionId, optionId). Any failure leaves baseQuestions as-is.
  const annotations = await callRanker({
    baseQuestions,
    goal: opts.goal,
    creativeDomain: opts.creativeDomain,
    snapshot,
    recentTurns,
    trendHints,
    llmRegistry: deps.llmRegistry,
  });
  if (!annotations) return baseQuestions;

  return applyAnnotations(baseQuestions, annotations, trendHints);
}

interface RankerAnnotation {
  questionId: string;
  optionRanking?: string[];
  suggestedDefaultOptionId?: string | null;
  rationale?: string | null;
  perOptionRationale?: Record<string, string>;
  questionRationale?: string | null;
}

interface CallRankerOpts {
  baseQuestions: ClarificationQuestion[];
  goal: string;
  creativeDomain: CreativeDomain;
  snapshot: UserContextSnapshot | undefined;
  recentTurns: Turn[];
  trendHints: ClarificationTrendHintMap;
  llmRegistry: LLMProviderRegistry;
}

const RANKER_SYSTEM_PROMPT = `You are a clarification-ranker for the Vinyan creative-content orchestrator.

Given a deterministic-template clarification question + its options + user history + an optional trend signal, your job is to:

  1. RANK the options most-relevant first (the user is likeliest to pick one of the top 2).
  2. PICK at most ONE option as the suggestedDefault — the strongest fit. Set null when there is no clear preference.
  3. Write a short rationale (≤ 120 chars) explaining the suggestedDefault choice.
  4. Optionally annotate per-option rationales when the user's history clearly biases a specific option (≤ 80 chars).
  5. Optionally write a question-level rationale (≤ 100 chars) when the user history justifies the whole framing.

ABSOLUTE RULES:
  - DO NOT invent option ids. Only use ids from the provided options array.
  - DO NOT invent trending hints — those come from the trend feed and are passed back to the orchestrator separately.
  - When the snapshot is empty / no history, OMIT rationales rather than fabricate. Output the option order unchanged with no defaults.
  - Output JSON only, no fences, no prose.

Output schema:
{
  "annotations": [
    {
      "questionId": "<exact id>",
      "optionRanking": ["<optionId1>", "<optionId2>", ...],          // optional
      "suggestedDefaultOptionId": "<optionId>" | null,                 // optional
      "rationale": "<short text>" | null,                              // optional
      "questionRationale": "<short text>" | null,                      // optional
      "perOptionRationale": { "<optionId>": "<short text>" }           // optional
    }
  ]
}`;

async function callRanker(opts: CallRankerOpts): Promise<RankerAnnotation[] | null> {
  const provider = opts.llmRegistry.selectByTier('fast') ?? opts.llmRegistry.selectByTier('balanced');
  if (!provider) return null;

  const userPrompt = buildRankerUserPrompt(opts);

  const ctrl = new AbortController();
  const timeout = setTimeout(() => ctrl.abort(), RANKER_TIMEOUT_MS);
  try {
    const response = await provider.generate({
      systemPrompt: RANKER_SYSTEM_PROMPT,
      userPrompt,
      maxTokens: RANKER_MAX_TOKENS,
      temperature: 0,
      tiers: frozenSystemTier(RANKER_SYSTEM_PROMPT, userPrompt),
    });
    return parseRankerResponse(response.content, opts.baseQuestions);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function buildRankerUserPrompt(opts: CallRankerOpts): string {
  const lines: string[] = [];
  lines.push(`Goal: ${opts.goal}`);
  lines.push(`Creative domain: ${opts.creativeDomain}`);
  lines.push('');
  lines.push('User context snapshot:');
  if (opts.snapshot && opts.snapshot.totalTracesInWindow > 0) {
    if (opts.snapshot.recentDomains.length > 0) {
      lines.push(`  recent domains: ${opts.snapshot.recentDomains.join(', ')}`);
    }
    if (opts.snapshot.recentKeywords.length > 0) {
      lines.push(
        `  recent keywords: ${opts.snapshot.recentKeywords
          .slice(0, 8)
          .map((k) => `${k.term}(${k.frequency})`)
          .join(', ')}`,
      );
    }
    if (opts.snapshot.frequentTaskTypes.length > 0) {
      lines.push(
        `  frequent task types: ${opts.snapshot.frequentTaskTypes
          .slice(0, 4)
          .map((t) => `${t.signature}(${t.count})`)
          .join(', ')}`,
      );
    }
  } else {
    lines.push('  (no prior history — leave rationales / suggestedDefaults empty)');
  }
  lines.push('');
  lines.push('Recent session turns:');
  if (opts.recentTurns.length > 0) {
    for (const turn of opts.recentTurns.slice(-4)) {
      const role = (turn as { role?: string }).role ?? '?';
      const content = String((turn as { content?: string }).content ?? '').slice(0, 160);
      lines.push(`  ${role}: ${content}`);
    }
  } else {
    lines.push('  (none)');
  }
  lines.push('');
  if (opts.trendHints.size > 0) {
    lines.push('Available trend signals (advisory — DO NOT echo into rationales):');
    for (const [key, hint] of opts.trendHints.entries()) {
      lines.push(`  ${key}: ${hint.text}${hint.score !== undefined ? ` (score=${hint.score.toFixed(2)})` : ''}`);
    }
    lines.push('');
  }
  lines.push('Questions:');
  for (const q of opts.baseQuestions) {
    lines.push(`- id: ${q.id}`);
    lines.push(`  prompt: ${q.prompt}`);
    if (q.options && q.options.length > 0) {
      const ids = q.options.map((o) => o.id).join(', ');
      lines.push(`  optionIds: [${ids}]`);
    }
  }
  lines.push('');
  lines.push('Return JSON only.');
  return lines.join('\n');
}

function parseRankerResponse(content: string, baseQuestions: ClarificationQuestion[]): RankerAnnotation[] | null {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const annotations = (parsed as { annotations?: unknown }).annotations;
  if (!Array.isArray(annotations)) return null;

  const knownQuestionIds = new Set(baseQuestions.map((q) => q.id));
  const knownOptionIdsByQuestion = new Map<string, Set<string>>();
  for (const q of baseQuestions) {
    knownOptionIdsByQuestion.set(q.id, new Set((q.options ?? []).map((o) => o.id)));
  }

  const out: RankerAnnotation[] = [];
  for (const raw of annotations) {
    if (!raw || typeof raw !== 'object') continue;
    const a = raw as Record<string, unknown>;
    const qid = typeof a.questionId === 'string' ? a.questionId : null;
    if (!qid || !knownQuestionIds.has(qid)) continue;
    const knownOpts = knownOptionIdsByQuestion.get(qid) ?? new Set<string>();

    const annotation: RankerAnnotation = { questionId: qid };
    if (Array.isArray(a.optionRanking)) {
      const ranking = a.optionRanking.filter((id): id is string => typeof id === 'string' && knownOpts.has(id));
      if (ranking.length > 0) annotation.optionRanking = ranking;
    }
    if (a.suggestedDefaultOptionId === null) {
      annotation.suggestedDefaultOptionId = null;
    } else if (typeof a.suggestedDefaultOptionId === 'string' && knownOpts.has(a.suggestedDefaultOptionId)) {
      annotation.suggestedDefaultOptionId = a.suggestedDefaultOptionId;
    }
    if (a.rationale === null) annotation.rationale = null;
    else if (typeof a.rationale === 'string') annotation.rationale = a.rationale.slice(0, 240);
    if (a.questionRationale === null) annotation.questionRationale = null;
    else if (typeof a.questionRationale === 'string') annotation.questionRationale = a.questionRationale.slice(0, 200);
    if (a.perOptionRationale && typeof a.perOptionRationale === 'object') {
      const m: Record<string, string> = {};
      for (const [optId, txt] of Object.entries(a.perOptionRationale)) {
        if (knownOpts.has(optId) && typeof txt === 'string' && txt.length > 0) {
          m[optId] = txt.slice(0, 200);
        }
      }
      if (Object.keys(m).length > 0) annotation.perOptionRationale = m;
    }
    out.push(annotation);
  }
  return out;
}

function applyAnnotations(
  baseQuestions: ClarificationQuestion[],
  annotations: RankerAnnotation[],
  trendHints: ClarificationTrendHintMap,
): ClarificationQuestion[] {
  const annByQuestion = new Map<string, RankerAnnotation>();
  for (const a of annotations) annByQuestion.set(a.questionId, a);
  return baseQuestions.map((q) => annotateQuestion(q, annByQuestion.get(q.id), trendHints));
}

function annotateQuestion(
  q: ClarificationQuestion,
  ann: RankerAnnotation | undefined,
  trendHints: ClarificationTrendHintMap,
): ClarificationQuestion {
  const next: ClarificationQuestion = { ...q };
  // Question-level rationale (only if the ranker explicitly emitted one).
  if (ann?.questionRationale) {
    next.questionRationale = ann.questionRationale;
  }
  if (!q.options || q.options.length === 0) return next;

  const ranked = ann?.optionRanking ? reorderByRanking(q.options, ann.optionRanking) : q.options;
  const suggestedId = ann?.suggestedDefaultOptionId ?? null;
  const perOpt = ann?.perOptionRationale ?? {};

  next.options = ranked.map((opt) => annotateOption(q.id, opt, suggestedId, perOpt[opt.id], trendHints));
  return next;
}

function reorderByRanking(options: ClarificationOption[], ranking: string[]): ClarificationOption[] {
  const byId = new Map(options.map((o) => [o.id, o]));
  const seen = new Set<string>();
  const ordered: ClarificationOption[] = [];
  for (const id of ranking) {
    const o = byId.get(id);
    if (o && !seen.has(id)) {
      ordered.push(o);
      seen.add(id);
    }
  }
  // Append any options the ranker didn't mention so the user always has the
  // full deterministic set.
  for (const o of options) if (!seen.has(o.id)) ordered.push(o);
  return ordered;
}

function annotateOption(
  questionId: string,
  opt: ClarificationOption,
  suggestedDefaultId: string | null,
  rationale: string | undefined,
  trendHints: ClarificationTrendHintMap,
): ClarificationOption {
  const next: ClarificationOption = { ...opt };
  if (suggestedDefaultId === opt.id) next.suggestedDefault = true;
  if (rationale) next.rationale = rationale;
  // Trend hints are sourced ONLY from the provider — never from the
  // ranker. Apply if the provider populated this composite key.
  const hint = trendHints.get(trendHintKey(questionId as never, opt.id));
  if (hint) next.trendingHint = hint.text;
  return next;
}

function hasPriorSessionTurns(
  sessionId: string | undefined,
  sessionManager: CreativeClarificationGateDeps['sessionManager'],
): boolean {
  if (!sessionId || !sessionManager) return false;
  try {
    // The API handler records the current user turn BEFORE dispatching, so
    // by the time this gate runs the session already has ≥1 turn from the
    // in-flight request. "Prior" means strictly older than that — we need at
    // least one additional turn to treat the session as having history.
    const turns = sessionManager.getTurnsHistory(sessionId, 2);
    return turns.length > 1;
  } catch {
    return false;
  }
}
