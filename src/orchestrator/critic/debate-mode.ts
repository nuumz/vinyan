/**
 * Architecture Debate Mode — 3-agent critic hardening.
 *
 * Book-integration Wave 2.1 (see docs/architecture/book-integration-overview.md).
 *
 * Shape (all 3 calls are separate LLM invocations with distinct system prompts):
 *
 *   ┌──────────────┐    ┌───────────────┐    ┌──────────────┐
 *   │  Advocate    │    │   Counter     │    │  Architect   │
 *   │ (defends)    │ -> │  (attacks)    │ -> │  (decides)   │
 *   └──────────────┘    └───────────────┘    └──────────────┘
 *          │                   │                    │
 *          └── proposal ──┐ ┌── attacks ──┐ └── verdict ──┐
 *                         ▼ ▼              ▼              ▼
 *                 DebateResult { approved, reason, confidence, rounds }
 *
 * Axiom compliance — checked question-by-question against the overview's filter:
 *
 *   Q1 (A1 Epistemic Separation): each agent runs in a distinct LLM call with a
 *   distinct system prompt. They never share a conversation context. The
 *   generator that *produced* the WorkerProposal is a fourth process the
 *   debate never talks to. Therefore generator ≠ verifier ≠ counter ≠ architect.
 *
 *   Q2 (A3 Deterministic Governance): debate activation is rule-based —
 *   `shouldDebate()` is a pure function of risk score + optional manual tag.
 *   No LLM decides whether the debate runs. The architect's verdict also goes
 *   through a deterministic aggregation (rule: if *any* critical attack
 *   survives the architect's defense, approved=false).
 *
 *   Q3 (A6 Zero-Trust): the debate does not touch the session overlay, the
 *   file system, or the tool executor. It reads a proposal and emits a verdict.
 *   Workers still propose-then-dispose through their existing contract.
 *
 * Cost:
 *   - 3 × `balanced` LLM calls (≈ Sonnet) by default. At L3 a caller may swap
 *     the provider to Opus for each seat — the pluggable `providers` prop lets
 *     the factory make that trade-off explicitly per role.
 *   - Budget guard lives in the orchestrator, not here — this module is pure.
 */
import type { VinyanBus } from '../../core/bus.ts';
import type { LLMProvider, LLMRequest, PerceptualHierarchy, TaskInput } from '../types.ts';
import type { CriticContext, CriticEngine, CriticResult, WorkerProposal } from './critic-engine.ts';

// ── Public types ────────────────────────────────────────────────────

/**
 * Three LLM provider seats for the debate. Pass the same provider three
 * times for cheap mode, or use distinct providers (fast / balanced / powerful)
 * to enforce separation by model family.
 */
export interface DebateProviders {
  advocate: LLMProvider;
  counter: LLMProvider;
  architect: LLMProvider;
}

export interface DebateConfig {
  /** Maximum tokens per seat — applied identically to all three calls. */
  maxTokensPerSeat?: number;
  /** Temperature for advocate/counter (high → diverse arguments). */
  argumentTemperature?: number;
  /** Temperature for architect (low → decisive verdict). */
  verdictTemperature?: number;
}

export interface DebateRound {
  seat: 'advocate' | 'counter' | 'architect';
  content: string;
  tokensUsed: { input: number; output: number };
}

export interface DebateCriticResult extends CriticResult {
  /** Structured transcript for operator review. Length is always 3. */
  rounds: DebateRound[];
}

const DEFAULT_MAX_TOKENS_PER_SEAT = 1500;
const DEFAULT_ARGUMENT_TEMPERATURE = 0.6;
const DEFAULT_VERDICT_TEMPERATURE = 0.1;

// ── Prompts ─────────────────────────────────────────────────────────

function buildAdvocatePrompt(): string {
  return `[ROLE]
You are the ADVOCATE. A separate engineer has proposed a code change. Your job
is to argue — in good faith — why the proposal is correct and should be merged.

[RULES]
- Do NOT invent new requirements. Defend the proposal as written.
- Cite concrete reasons tied to the stated goal and acceptance criteria.
- Call out the strongest properties: correctness, coverage, minimality.
- Output plain prose, 6-10 bullet points maximum. No JSON. No markdown headers.`;
}

function buildCounterPrompt(): string {
  return `[ROLE]
You are the COUNTER. The ADVOCATE has argued a proposal should be merged. Your
job is to find the sharpest reasons it should NOT.

[RULES]
- Your goal is to produce attacks a senior reviewer would actually raise.
- Look for: logic bugs, missed edge cases, silent regressions in code the
  proposal didn't touch but depends on, protocol violations, API contract
  drift, missed acceptance criteria.
- For each attack, state the severity: "blocking", "non-blocking", or "nit".
- Output plain prose, 6-10 bullet points maximum. No JSON. No markdown headers.`;
}

function buildArchitectPrompt(): string {
  return `[ROLE]
You are the ARCHITECT. You just watched an ADVOCATE and COUNTER argue about a
proposed code change. Your job is to produce the final verdict.

[DECISION RULE]
- If the COUNTER raised at least one "blocking" attack that the ADVOCATE did
  not successfully rebut, you MUST set "approved": false.
- If no blocking attacks survive, set "approved": true.
- "nit" severity never blocks approval.

[OUTPUT FORMAT]
Respond with a single JSON object, no prose around it:
{
  "approved": boolean,
  "reason": "1-2 sentence justification",
  "unresolved_attacks": ["list of attacks you consider still blocking"],
  "key_strengths": ["list of proposal properties you agree are solid"]
}`;
}

function buildSharedContext(
  proposal: WorkerProposal,
  task: TaskInput,
  perception: PerceptualHierarchy,
  acceptanceCriteria?: string[],
): string {
  const sections: string[] = [];
  sections.push(`[TASK GOAL]\n${task.goal}`);

  if (acceptanceCriteria && acceptanceCriteria.length > 0) {
    const criteria = acceptanceCriteria.map((c, i) => `  ${i + 1}. ${c}`).join('\n');
    sections.push(`[ACCEPTANCE CRITERIA]\n${criteria}`);
  }

  const mutationSummary = proposal.mutations.map((m) => `--- ${m.file} ---\n${m.content}`).join('\n\n');
  sections.push(`[PROPOSED MUTATIONS]\n${mutationSummary}`);

  if (proposal.approach) {
    sections.push(`[APPROACH]\n${proposal.approach}`);
  }

  sections.push(
    `[CONTEXT]\nTarget: ${perception.taskTarget.file} — ${perception.taskTarget.description}\nBlast radius: ${perception.dependencyCone.transitiveBlastRadius} files`,
  );

  return sections.join('\n\n');
}

// ── Debate runner ───────────────────────────────────────────────────

export class ArchitectureDebateCritic implements CriticEngine {
  constructor(
    private readonly providers: DebateProviders,
    private readonly config: DebateConfig = {},
  ) {}

  async review(
    proposal: WorkerProposal,
    task: TaskInput,
    perception: PerceptualHierarchy,
    acceptanceCriteria?: string[],
    // Wave 5.1: the 3-seat debate itself doesn't consume the routing
    // context today — the trigger decision happens in DebateRouterCritic
    // below. Accept-and-ignore so the CriticEngine interface stays
    // uniform across all implementations.
    _context?: CriticContext,
  ): Promise<DebateCriticResult> {
    const maxTokens = this.config.maxTokensPerSeat ?? DEFAULT_MAX_TOKENS_PER_SEAT;
    const argumentTemperature = this.config.argumentTemperature ?? DEFAULT_ARGUMENT_TEMPERATURE;
    const verdictTemperature = this.config.verdictTemperature ?? DEFAULT_VERDICT_TEMPERATURE;

    const sharedContext = buildSharedContext(proposal, task, perception, acceptanceCriteria);
    const rounds: DebateRound[] = [];
    let totalInput = 0;
    let totalOutput = 0;

    // 1. Advocate — argue FOR the proposal
    const advocateRequest: LLMRequest = {
      systemPrompt: buildAdvocatePrompt(),
      userPrompt: sharedContext,
      maxTokens,
      temperature: argumentTemperature,
    };
    let advocateResponse: import('../types.ts').LLMResponse;
    try {
      advocateResponse = await this.providers.advocate.generate(advocateRequest);
    } catch {
      return failClosedDebate(rounds, 'advocate call failed');
    }
    rounds.push({
      seat: 'advocate',
      content: advocateResponse.content,
      tokensUsed: advocateResponse.tokensUsed,
    });
    totalInput += advocateResponse.tokensUsed.input;
    totalOutput += advocateResponse.tokensUsed.output;

    // 2. Counter — argue AGAINST, given the advocate's argument
    const counterUserPrompt = `${sharedContext}\n\n[ADVOCATE ARGUMENT]\n${advocateResponse.content}`;
    const counterRequest: LLMRequest = {
      systemPrompt: buildCounterPrompt(),
      userPrompt: counterUserPrompt,
      maxTokens,
      temperature: argumentTemperature,
    };
    let counterResponse: import('../types.ts').LLMResponse;
    try {
      counterResponse = await this.providers.counter.generate(counterRequest);
    } catch {
      return failClosedDebate(rounds, 'counter call failed');
    }
    rounds.push({
      seat: 'counter',
      content: counterResponse.content,
      tokensUsed: counterResponse.tokensUsed,
    });
    totalInput += counterResponse.tokensUsed.input;
    totalOutput += counterResponse.tokensUsed.output;

    // 3. Architect — decide, given both arguments
    const architectUserPrompt = [
      sharedContext,
      `[ADVOCATE ARGUMENT]\n${advocateResponse.content}`,
      `[COUNTER ARGUMENT]\n${counterResponse.content}`,
    ].join('\n\n');
    const architectRequest: LLMRequest = {
      systemPrompt: buildArchitectPrompt(),
      userPrompt: architectUserPrompt,
      maxTokens,
      temperature: verdictTemperature,
    };
    let architectResponse: import('../types.ts').LLMResponse;
    try {
      architectResponse = await this.providers.architect.generate(architectRequest);
    } catch {
      return failClosedDebate(rounds, 'architect call failed');
    }
    rounds.push({
      seat: 'architect',
      content: architectResponse.content,
      tokensUsed: architectResponse.tokensUsed,
    });
    totalInput += architectResponse.tokensUsed.input;
    totalOutput += architectResponse.tokensUsed.output;

    const parsed = parseArchitectVerdict(architectResponse.content);
    if (!parsed) {
      return {
        approved: false,
        confidence: 0.3,
        reason: 'architect verdict could not be parsed — fail-closed per A2',
        verdicts: {},
        tokensUsed: { input: totalInput, output: totalOutput },
        aspects: [
          {
            name: 'parse_failure',
            passed: false,
            explanation: 'architect returned non-JSON payload',
          },
        ],
        rounds,
      };
    }

    // Deterministic confidence = proportion of key_strengths that survived
    // vs unresolved_attacks. This deliberately ignores any LLM self-reported
    // score — A5 tiered trust: llm-self-report is filtered from governance.
    const strengths = parsed.key_strengths.length;
    const blockers = parsed.unresolved_attacks.length;
    const totalEvidence = strengths + blockers;
    const confidence = totalEvidence > 0 ? strengths / totalEvidence : 0.5;

    return {
      approved: parsed.approved && blockers === 0,
      confidence,
      reason: parsed.reason,
      verdicts: {},
      tokensUsed: { input: totalInput, output: totalOutput },
      aspects: [
        {
          name: 'advocate_strength',
          passed: strengths > 0,
          explanation: `advocate cited ${strengths} agreed strengths`,
        },
        {
          name: 'counter_blockers',
          passed: blockers === 0,
          explanation:
            blockers === 0
              ? 'no blocking attacks survived debate'
              : `${blockers} blocking attack(s) survived: ${parsed.unresolved_attacks.join('; ').slice(0, 200)}`,
        },
      ],
      rounds,
    };
  }
}

// ── Parsing ─────────────────────────────────────────────────────────

interface ArchitectVerdict {
  approved: boolean;
  reason: string;
  unresolved_attacks: string[];
  key_strengths: string[];
}

function parseArchitectVerdict(content: string): ArchitectVerdict | null {
  try {
    let jsonStr = content.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1]?.trim() ?? jsonStr;
    }

    const parsed = JSON.parse(jsonStr);
    if (typeof parsed.approved !== 'boolean') return null;
    if (!Array.isArray(parsed.unresolved_attacks)) return null;
    if (!Array.isArray(parsed.key_strengths)) return null;

    return {
      approved: parsed.approved,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
      unresolved_attacks: parsed.unresolved_attacks.filter((x: unknown): x is string => typeof x === 'string'),
      key_strengths: parsed.key_strengths.filter((x: unknown): x is string => typeof x === 'string'),
    };
  } catch {
    return null;
  }
}

function failClosedDebate(rounds: DebateRound[], reason: string): DebateCriticResult {
  return {
    approved: false,
    confidence: 0.3,
    reason: `debate aborted: ${reason}`,
    verdicts: {},
    tokensUsed: { input: 0, output: 0 },
    aspects: [{ name: 'debate_completed', passed: false, explanation: reason }],
    rounds,
  };
}

// ── Deterministic trigger ───────────────────────────────────────────

export interface DebateTriggerInput {
  /** Optional risk score computed by the risk router. */
  riskScore?: number;
  /** Optional manual override tag. Set via task constraints `DEBATE:force`. */
  manualOverride?: 'force' | 'skip';
  /** Defaults to 0.7 per overview §8 Q1. */
  threshold?: number;
}

export function shouldDebate(input: DebateTriggerInput): boolean {
  if (input.manualOverride === 'skip') return false;
  if (input.manualOverride === 'force') return true;
  const threshold = input.threshold ?? 0.7;
  return (input.riskScore ?? 0) >= threshold;
}

/**
 * Parse the debate override from task constraints. Recognized strings:
 *   "DEBATE:force" — always run debate mode regardless of risk score
 *   "DEBATE:skip"  — never run debate mode even if risk exceeds threshold
 * Returns undefined when no directive is present so the caller can fall
 * through to risk-based triggering.
 */
export function parseDebateOverride(constraints?: string[]): 'force' | 'skip' | undefined {
  if (!constraints) return undefined;
  for (const c of constraints) {
    if (c === 'DEBATE:force') return 'force';
    if (c === 'DEBATE:skip') return 'skip';
  }
  return undefined;
}

// ── Router critic ───────────────────────────────────────────────────

/**
 * Router critic that delegates to either the baseline critic or the
 * debate critic. Selection is rule-based:
 *   - if `DEBATE:skip` is in constraints → baseline always
 *   - if `DEBATE:force` is in constraints → debate always
 *   - otherwise → baseline unless risk score ≥ threshold
 *
 * Wave 5.1: `riskScore` is now read from the `CriticContext` argument
 * threaded by the core loop, replacing the previous
 * `(task as unknown as { riskScore? }).riskScore` cast. The router
 * also accepts an optional bus so dashboards can observe when the
 * debate path actually fires (see `critic:debate_fired`).
 *
 * A3-safe: no LLM in the selection path.
 */
export class DebateRouterCritic implements CriticEngine {
  constructor(
    private readonly baseline: CriticEngine,
    private readonly debate: CriticEngine,
    private readonly options: {
      threshold?: number;
      /**
       * Wave 5 observability: optional bus for emitting
       * `critic:debate_fired` when the router picks the debate path.
       * Absent ⇒ silent routing (unchanged from the pre-Wave-5 version).
       */
      bus?: VinyanBus;
    } = {},
  ) {}

  async review(
    proposal: WorkerProposal,
    task: TaskInput,
    perception: PerceptualHierarchy,
    acceptanceCriteria?: string[],
    context?: CriticContext,
  ): Promise<CriticResult> {
    const manual = parseDebateOverride(task.constraints);
    // Wave 5.1: routing signal arrives via the typed `context`
    // argument. If the caller didn't pass one, fall through to
    // baseline — the router must never elevate a fuzzy task input
    // to debate mode silently.
    const riskScore = context?.riskScore;
    const fire = shouldDebate({
      manualOverride: manual,
      riskScore,
      ...(this.options.threshold !== undefined ? { threshold: this.options.threshold } : {}),
    });

    if (fire) {
      this.options.bus?.emit('critic:debate_fired', {
        taskId: task.id,
        riskScore,
        routingLevel: context?.routingLevel,
        trigger: manual ?? 'risk-threshold',
      });
      return this.debate.review(proposal, task, perception, acceptanceCriteria, context);
    }
    return this.baseline.review(proposal, task, perception, acceptanceCriteria, context);
  }
}
