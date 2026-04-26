/**
 * SoulReflector — LLM-powered reflection engine for agent self-improvement.
 *
 * Two operations:
 *   1. reflectOnTrace: per-task reflection → PendingInsight (cheap, ~$0.001)
 *   2. synthesizeInsights: sleep-cycle batch synthesis → updated SoulDocument
 *
 * A1 compliance: Reflection asks about PROCESS ("how should I approach similar
 * tasks?"), NOT about output quality ("was my output good?"). The agent reflects
 * on its decision-making strategy, not on whether its code was correct — that's
 * the oracle's job.
 *
 * Source of truth: Living Agent Soul plan
 */
import type { AgentContextStore } from '../../db/agent-context-store.ts';
import type { LLMProvider } from '../types.ts';
import type { ExecutionTrace } from '../types.ts';
import type { SoulDocument, PendingInsight, DomainEntry, StrategyEntry, AntiPatternEntry } from './soul-schema.ts';
import { parseSoulMd, renderSoulMd, createSeedSoul, SOUL_MAX_TOKENS, countSoulTokens, SOUL_SECTION_LIMITS } from './soul-schema.ts';
import { SoulStore } from './soul-store.ts';
import { isSignificant, isRateLimited, recordReflection } from './soul-significance-gate.ts';
import type { AgentContext } from './types.ts';

export interface SoulReflectorDeps {
  provider: LLMProvider;
  soulStore: SoulStore;
  agentContextStore: AgentContextStore;
}

/** Maximum soul updates per 24 hours (version dampening). */
const MAX_UPDATES_PER_DAY = 5;
/** Maximum insights merged per sleep cycle. */
const MAX_INSIGHTS_PER_CYCLE = 3;

export class SoulReflector {
  private provider: LLMProvider;
  private soulStore: SoulStore;
  private agentContextStore: AgentContextStore;

  constructor(deps: SoulReflectorDeps) {
    this.provider = deps.provider;
    this.soulStore = deps.soulStore;
    this.agentContextStore = deps.agentContextStore;
  }

  /**
   * Reflect on a single trace. Returns a PendingInsight if the trace is
   * significant and not rate-limited, null otherwise.
   *
   * Best-effort: never throws. LLM failures are silently swallowed.
   */
  async reflectOnTrace(agentId: string, trace: ExecutionTrace, agentContext: AgentContext): Promise<PendingInsight | null> {
    // Check significance gate
    if (!isSignificant(trace, agentContext)) return null;
    if (isRateLimited(agentId)) return null;

    try {
      const soul = this.soulStore.loadSoul(agentId);
      const soulContent = soul ? renderSoulMd(soul) : '(no soul yet — first reflection)';

      const prompt = buildReflectionPrompt(soulContent, trace);
      const response = await this.provider.generate({
        systemPrompt: REFLECTION_SYSTEM_PROMPT,
        userPrompt: prompt,
        maxTokens: 300,
        temperature: 0.3,
      });

      recordReflection(agentId);

      const insight = parseReflectionResponse(response.content, trace);
      if (insight) {
        this.agentContextStore.appendPendingInsight(agentId, insight);
      }
      return insight;
    } catch {
      // Best-effort — LLM reflection failure never blocks the pipeline
      return null;
    }
  }

  /**
   * Synthesize accumulated insights into an updated SoulDocument.
   * Called during sleep cycle. Merges pending insights + mined data.
   *
   * If LLM synthesis fails, falls back to deterministic merging.
   */
  async synthesizeInsights(
    agentId: string,
    insights: PendingInsight[],
    minedData?: {
      domainKnowledge?: DomainEntry[];
      strategies?: StrategyEntry[];
      antiPatterns?: AntiPatternEntry[];
    },
  ): Promise<SoulDocument> {
    const existingSoul = this.soulStore.loadSoul(agentId) ?? createSeedSoul(agentId, 'balanced');

    // Version dampening: check update frequency
    if (existingSoul.version >= MAX_UPDATES_PER_DAY) {
      const lastUpdate = new Date(existingSoul.updatedAt).getTime();
      const hoursSinceUpdate = (Date.now() - lastUpdate) / (1000 * 60 * 60);
      if (hoursSinceUpdate < 24) {
        return existingSoul; // Too many updates recently — skip
      }
    }

    // Limit insights per cycle
    const topInsights = insights
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, MAX_INSIGHTS_PER_CYCLE);

    try {
      const prompt = buildSynthesisPrompt(existingSoul, topInsights, minedData);
      const response = await this.provider.generate({
        systemPrompt: SYNTHESIS_SYSTEM_PROMPT,
        userPrompt: prompt,
        maxTokens: 2000,
        temperature: 0.2,
      });

      const updatedSoul = parseSynthesisResponse(response.content, existingSoul);

      // Enforce token budget
      if (countSoulTokens(updatedSoul) > SOUL_MAX_TOKENS) {
        return trimSoul(updatedSoul);
      }

      // Save — SoulStore (filesystem) is the only source of truth.
      this.soulStore.saveSoul(updatedSoul);
      this.agentContextStore.clearPendingInsights(agentId);

      return updatedSoul;
    } catch {
      // Fallback: deterministic merge without LLM
      return this.deterministicMerge(existingSoul, topInsights, minedData);
    }
  }

  /** Deterministic fallback when LLM is unavailable. */
  private deterministicMerge(
    soul: SoulDocument,
    insights: PendingInsight[],
    minedData?: {
      domainKnowledge?: DomainEntry[];
      strategies?: StrategyEntry[];
      antiPatterns?: AntiPatternEntry[];
    },
  ): SoulDocument {
    const updated = { ...soul };
    updated.version++;
    updated.updatedAt = new Date().toISOString();

    // Merge mined data
    if (minedData?.domainKnowledge) {
      for (const entry of minedData.domainKnowledge) {
        if (!updated.domainExpertise.some((e) => e.area === entry.area)) {
          updated.domainExpertise.push(entry);
        }
      }
      updated.domainExpertise = updated.domainExpertise.slice(0, SOUL_SECTION_LIMITS.domainExpertise);
    }

    if (minedData?.strategies) {
      for (const entry of minedData.strategies) {
        if (!updated.winningStrategies.some((s) => s.taskPattern === entry.taskPattern)) {
          updated.winningStrategies.push(entry);
        }
      }
      updated.winningStrategies = updated.winningStrategies.slice(0, SOUL_SECTION_LIMITS.winningStrategies);
    }

    if (minedData?.antiPatterns) {
      for (const entry of minedData.antiPatterns) {
        if (!updated.antiPatterns.some((a) => a.pattern === entry.pattern)) {
          updated.antiPatterns.push(entry);
        }
      }
      updated.antiPatterns = updated.antiPatterns.slice(0, SOUL_SECTION_LIMITS.antiPatterns);
    }

    // Merge insights as text
    for (const insight of insights) {
      if (insight.category === 'self-knowledge') {
        if (updated.selfKnowledge.length < SOUL_SECTION_LIMITS.selfKnowledge) {
          updated.selfKnowledge.push(insight.content);
        }
      } else if (insight.category === 'anti-pattern') {
        if (updated.antiPatterns.length < SOUL_SECTION_LIMITS.antiPatterns) {
          updated.antiPatterns.push({
            pattern: insight.content,
            cause: insight.evidence,
            evidenceCount: 1,
            oracleInvolved: '',
          });
        }
      }
    }

    this.soulStore.saveSoul(updated);
    this.agentContextStore.clearPendingInsights(updated.agentId);

    return updated;
  }
}

/** Build a statistical soul from ACL data without any LLM call. */
export function buildStatisticalSoul(agentId: string, context: AgentContext): SoulDocument {
  const soul = createSeedSoul(agentId, 'balanced');

  // Derive philosophy from approach style
  if (context.identity.approachStyle) {
    soul.philosophy = context.identity.approachStyle;
  }

  // Convert strengths to domain expertise
  for (const strength of context.identity.strengths.slice(0, SOUL_SECTION_LIMITS.domainExpertise)) {
    soul.domainExpertise.push({
      area: strength,
      files: [],
      knowledge: `Consistently successful (from capability model)`,
      lastEvidence: Date.now(),
    });
  }

  // Convert preferred approaches to strategies
  for (const [taskSig, approach] of Object.entries(context.skills.preferredApproaches).slice(0, SOUL_SECTION_LIMITS.winningStrategies)) {
    soul.winningStrategies.push({
      taskPattern: taskSig,
      strategy: approach,
      evidenceCount: context.skills.proficiencies[taskSig]?.totalAttempts ?? 0,
      lastSuccess: Date.now(),
    });
  }

  // Convert anti-patterns
  for (const pattern of context.skills.antiPatterns.slice(0, SOUL_SECTION_LIMITS.antiPatterns)) {
    const [what, ...why] = pattern.split(':');
    soul.antiPatterns.push({
      pattern: what?.trim() ?? pattern,
      cause: why.join(':').trim() || 'observed from prior failures',
      evidenceCount: 1,
      oracleInvolved: '',
    });
  }

  // Self-knowledge from weaknesses
  soul.selfKnowledge = context.identity.weaknesses.slice(0, SOUL_SECTION_LIMITS.selfKnowledge)
    .map((w) => `Weak area: ${w}`);

  return soul;
}

// ── Prompts ─────────────────────────────────────────────────────────

const REFLECTION_SYSTEM_PROMPT = `You are a reflection engine analyzing an agent's task execution PROCESS.
Your job is to extract PROCESS insights — how the agent approached the task,
what strategies worked or failed, and what the agent should do differently.

You are NOT evaluating output quality (that's the oracle's job).
You ARE analyzing: approach strategy, information gathering, decision heuristics.

Output a single JSON object or the word "null" if no insight.`;

function buildReflectionPrompt(soulContent: string, trace: ExecutionTrace): string {
  const oracleStr = Object.entries(trace.oracleVerdicts ?? {})
    .map(([k, v]) => `${k}: ${v ? 'pass' : 'FAIL'}`)
    .join(', ');

  return `Current Soul:
${soulContent}

Task Trace:
- Task type: ${trace.taskTypeSignature ?? 'unknown'}
- Outcome: ${trace.outcome}
- Approach: ${trace.approach ?? 'not recorded'}${trace.approachDescription ? `\n- Detailed approach: ${trace.approachDescription}` : ''}
- Duration: ${trace.durationMs}ms
- Oracle verdicts: ${oracleStr || 'none'}${trace.failureReason ? `\n- Failure reason: ${trace.failureReason}` : ''}${trace.predictionError ? `\n- Prediction error: ${trace.predictionError.error.composite.toFixed(2)} (agent was surprised by this outcome)` : ''}
- Files involved: ${(trace.affectedFiles ?? []).join(', ') || 'none'}

Output JSON:
{
  "category": "strategy" | "anti-pattern" | "domain" | "self-knowledge" | "experiment",
  "content": "concise insight (1-2 sentences)",
  "evidence": "what in the trace supports this",
  "confidence": 0.0 to 1.0
}

Or output: null`;
}

function parseReflectionResponse(content: string, trace: ExecutionTrace): PendingInsight | null {
  const trimmed = content.trim();
  if (trimmed === 'null' || trimmed === '""' || trimmed === '') return null;

  try {
    // Try to extract JSON from the response
    const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.category || !parsed.content) return null;

    return {
      traceId: trace.id,
      timestamp: Date.now(),
      category: parsed.category,
      content: String(parsed.content).slice(0, 300),
      evidence: String(parsed.evidence ?? '').slice(0, 200),
      confidence: typeof parsed.confidence === 'number' ? Math.min(1, Math.max(0, parsed.confidence)) : 0.5,
    };
  } catch {
    return null;
  }
}

const SYNTHESIS_SYSTEM_PROMPT = `You update an agent's Soul document by merging new insights.
Output ONLY the updated SOUL.md content in markdown format.
Respect all section limits. Be concise — the soul must fit in ~1500 tokens.
Do NOT evaluate the agent's code quality. Focus on PROCESS wisdom.`;

function buildSynthesisPrompt(
  soul: SoulDocument,
  insights: PendingInsight[],
  minedData?: {
    domainKnowledge?: DomainEntry[];
    strategies?: StrategyEntry[];
    antiPatterns?: AntiPatternEntry[];
  },
): string {
  const parts = [`Current SOUL.md:\n${renderSoulMd(soul)}\n`];

  if (insights.length > 0) {
    parts.push('New insights from recent tasks:');
    for (const insight of insights) {
      parts.push(`- [${insight.category}] ${insight.content} (evidence: ${insight.evidence}, confidence: ${insight.confidence.toFixed(2)})`);
    }
  }

  if (minedData?.domainKnowledge?.length) {
    parts.push('\nMined domain knowledge:');
    for (const d of minedData.domainKnowledge) {
      parts.push(`- ${d.area}: ${d.knowledge}`);
    }
  }

  if (minedData?.strategies?.length) {
    parts.push('\nMined winning strategies:');
    for (const s of minedData.strategies) {
      parts.push(`- ${s.taskPattern}: ${s.strategy} (${s.evidenceCount} successes)`);
    }
  }

  if (minedData?.antiPatterns?.length) {
    parts.push('\nMined anti-patterns:');
    for (const a of minedData.antiPatterns) {
      parts.push(`- ${a.pattern}: ${a.cause}`);
    }
  }

  parts.push(`\nSection limits: philosophy=${SOUL_SECTION_LIMITS.philosophy} lines, domain=${SOUL_SECTION_LIMITS.domainExpertise}, strategies=${SOUL_SECTION_LIMITS.winningStrategies}, anti-patterns=${SOUL_SECTION_LIMITS.antiPatterns}, self-knowledge=${SOUL_SECTION_LIMITS.selfKnowledge}, experiments=${SOUL_SECTION_LIMITS.activeExperiments}`);
  parts.push('\nOutput the complete updated SOUL.md (keep the # Soul: header and <!-- version --> comment):');

  return parts.join('\n');
}

function parseSynthesisResponse(content: string, existingSoul: SoulDocument): SoulDocument {
  try {
    const parsed = parseSoulMd(content);
    // Preserve agentId from existing soul (LLM might mangle it)
    parsed.agentId = existingSoul.agentId;
    parsed.version = existingSoul.version + 1;
    parsed.updatedAt = new Date().toISOString();
    return parsed;
  } catch {
    // If parsing fails, return existing soul with incremented version
    return { ...existingSoul, version: existingSoul.version + 1, updatedAt: new Date().toISOString() };
  }
}

function trimSoul(soul: SoulDocument): SoulDocument {
  return {
    ...soul,
    domainExpertise: soul.domainExpertise.slice(0, SOUL_SECTION_LIMITS.domainExpertise),
    winningStrategies: soul.winningStrategies.slice(0, SOUL_SECTION_LIMITS.winningStrategies),
    antiPatterns: soul.antiPatterns.slice(0, SOUL_SECTION_LIMITS.antiPatterns),
    selfKnowledge: soul.selfKnowledge.slice(0, SOUL_SECTION_LIMITS.selfKnowledge),
    activeExperiments: soul.activeExperiments.slice(0, SOUL_SECTION_LIMITS.activeExperiments),
  };
}
