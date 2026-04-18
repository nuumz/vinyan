/**
 * AgentEvolution — sleep cycle agent identity refinement.
 *
 * Called periodically during the sleep cycle to:
 * 1. Compact episodic memory (summarize lessons, drop low-signal episodes)
 * 2. Refine persona based on accumulated trace patterns
 * 3. Graduate skill proficiencies from capability data
 * 4. Update strengths/weaknesses from CapabilityModel
 *
 * All operations are deterministic and rule-based (A3).
 *
 * Source of truth: ultraplan — Agent Contextual Redesign, Phase 6
 */
import type { Database } from 'bun:sqlite';
import type { AgentContextStore } from '../../db/agent-context-store.ts';
import type { CapabilityModel } from '../fleet/capability-model.ts';
import type { SoulReflector } from './soul-reflector.ts';
import { buildStatisticalSoul } from './soul-reflector.ts';
import { SoulStore } from './soul-store.ts';
import { extractDomainKnowledge, type TraceForDomain } from './domain-knowledge-extractor.ts';
import { mineStrategies, type TraceForStrategy } from './strategy-miner.ts';
import { analyzeAntiPatterns, type TraceForAntiPattern } from './anti-pattern-analyzer.ts';
import type { AgentContext, SkillLevel } from './types.ts';

export interface AgentEvolutionDeps {
  agentContextStore: AgentContextStore;
  capabilityModel?: CapabilityModel;
  /** Living Agent Soul: LLM-powered synthesis (optional — falls back to statistical soul). */
  soulReflector?: SoulReflector;
  soulStore?: SoulStore;
  /** Direct DB access for trace queries. */
  db?: Database;
}

export interface AgentEvolutionResult {
  agentsEvolved: number;
  episodesCompacted: number;
  personasRefined: number;
  skillsGraduated: number;
  soulsEvolved: number;
}

export class AgentEvolution {
  private store: AgentContextStore;
  private capabilityModel?: CapabilityModel;
  private soulReflector?: SoulReflector;
  private soulStore?: SoulStore;
  private db?: Database;

  constructor(deps: AgentEvolutionDeps) {
    this.store = deps.agentContextStore;
    this.capabilityModel = deps.capabilityModel;
    this.soulReflector = deps.soulReflector;
    this.soulStore = deps.soulStore;
    this.db = deps.db;
  }

  /**
   * Evolve all agents with stored contexts.
   * Called during each sleep cycle.
   */
  async evolveAll(): Promise<AgentEvolutionResult> {
    const contexts = this.store.findAll();
    const result: AgentEvolutionResult = {
      agentsEvolved: 0,
      episodesCompacted: 0,
      personasRefined: 0,
      skillsGraduated: 0,
      soulsEvolved: 0,
    };

    for (const context of contexts) {
      const changes = this.evolveAgent(context);
      if (changes.changed) {
        context.lastUpdated = Date.now();
        this.store.upsert(context);
        result.agentsEvolved++;
      }
      result.episodesCompacted += changes.episodesCompacted;
      result.personasRefined += changes.personaRefined ? 1 : 0;
      result.skillsGraduated += changes.skillsGraduated;

      // Living Agent Soul: synthesize pending insights into SOUL.md
      const soulEvolved = await this.evolveSoul(context);
      if (soulEvolved) result.soulsEvolved++;
    }

    return result;
  }

  /** Evolve an agent's soul from pending insights + mined data. */
  private async evolveSoul(context: AgentContext): Promise<boolean> {
    const agentId = context.identity.agentId;

    try {
      // Load pending insights
      const insights = this.store.getPendingInsights(agentId);

      // Mine data from traces (deterministic)
      const traces = this.loadAgentTraces(agentId);
      const domainKnowledge = traces.length > 0 ? extractDomainKnowledge(traces) : undefined;
      // Trace projections share common fields; the miners handle missing fields gracefully
      const strategies = traces.length > 0 ? mineStrategies(traces as unknown as TraceForStrategy[]) : undefined;
      const antiPatterns = traces.length > 0 ? analyzeAntiPatterns(traces as unknown as TraceForAntiPattern[]) : undefined;

      const minedData = { domainKnowledge, strategies, antiPatterns };

      if (this.soulReflector && insights.length > 0) {
        // LLM-powered synthesis
        await this.soulReflector.synthesizeInsights(agentId, insights, minedData);
        return true;
      } else if (this.soulStore && (insights.length > 0 || traces.length >= 5)) {
        // Deterministic fallback: build statistical soul
        const soul = buildStatisticalSoul(agentId, context);
        // Merge mined data
        if (domainKnowledge) soul.domainExpertise = domainKnowledge;
        if (strategies) soul.winningStrategies = strategies;
        if (antiPatterns) soul.antiPatterns = antiPatterns.map((a) => ({
          pattern: a.pattern, cause: a.cause, evidenceCount: a.evidenceCount, oracleInvolved: a.oracleInvolved,
        }));
        this.soulStore.saveSoul(soul);
        this.store.clearPendingInsights(agentId);
        return true;
      }
    } catch {
      /* Soul evolution is best-effort */
    }
    return false;
  }

  /** Load recent traces for an agent (for data mining). */
  private loadAgentTraces(agentId: string): TraceForDomain[] {
    if (!this.db) return [];
    try {
      // Multi-agent: prefer specialist id (agent_id) over oracle id
      // (worker_id). The OR clause preserves reads over pre-migration rows
      // where only worker_id was recorded — remove once all traces are
      // multi-agent-tagged.
      const rows = this.db
        .prepare(
          `SELECT outcome, affected_files, oracle_verdicts, approach, approach_description,
                  task_type_signature, failure_reason, timestamp
           FROM execution_traces
           WHERE (agent_id = ? OR (agent_id IS NULL AND worker_id = ?))
           ORDER BY timestamp DESC LIMIT 50`,
        )
        .all(agentId, agentId) as Array<Record<string, unknown>>;

      return rows.map((row) => ({
        outcome: row.outcome as TraceForDomain['outcome'],
        affectedFiles: row.affected_files ? JSON.parse(row.affected_files as string) : [],
        oracleVerdicts: row.oracle_verdicts ? JSON.parse(row.oracle_verdicts as string) : {},
        approach: (row.approach as string) ?? '',
        approachDescription: row.approach_description as string | undefined,
        taskTypeSignature: row.task_type_signature as string | undefined,
        failureReason: row.failure_reason as string | undefined,
        timestamp: row.timestamp as number,
      }));
    } catch {
      return [];
    }
  }

  private evolveAgent(context: AgentContext): {
    changed: boolean;
    episodesCompacted: number;
    personaRefined: boolean;
    skillsGraduated: number;
  } {
    let changed = false;

    // 1. Lesson compaction — summarize episodes into lessonsSummary
    const compacted = this.compactLessons(context);
    if (compacted > 0) changed = true;

    // 2. Persona refinement from accumulated skill data
    const personaRefined = this.refinePersona(context);
    if (personaRefined) changed = true;

    // 3. Skill graduation from CapabilityModel
    const graduated = this.graduateSkills(context);
    if (graduated > 0) changed = true;

    // 4. Update strengths/weaknesses from CapabilityModel
    if (this.capabilityModel) {
      const capsUpdated = this.updateCapabilities(context);
      if (capsUpdated) changed = true;
    }

    return { changed, episodesCompacted: compacted, personaRefined, skillsGraduated: graduated };
  }

  /**
   * Compact episodic memory: build a compressed summary and evict low-signal episodes.
   * Returns the number of changes made (summary update counts as 1, plus evicted count).
   */
  private compactLessons(context: AgentContext): number {
    const episodes = context.memory.episodes;
    if (episodes.length < 5) return 0; // not enough to compact

    // Count outcome frequencies
    const successes = episodes.filter((e) => e.outcome === 'success').length;
    const failures = episodes.filter((e) => e.outcome === 'failed').length;
    const partial = episodes.filter((e) => e.outcome === 'partial').length;

    // Extract unique lessons from failures (most valuable)
    const failureLessons = episodes
      .filter((e) => e.outcome === 'failed' && e.lesson)
      .map((e) => e.lesson)
      .slice(0, 5);

    // Build summary
    const parts: string[] = [];
    parts.push(`Experience: ${episodes.length} tasks (${successes} success, ${failures} failed, ${partial} partial).`);

    if (failureLessons.length > 0) {
      parts.push(`Key lessons from failures: ${failureLessons.join('; ')}`);
    }

    // Extract most common task signatures
    const sigCounts = new Map<string, number>();
    for (const ep of episodes) {
      sigCounts.set(ep.taskSignature, (sigCounts.get(ep.taskSignature) ?? 0) + 1);
    }
    const topSigs = [...sigCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([sig, count]) => `${sig} (×${count})`);

    if (topSigs.length > 0) {
      parts.push(`Most frequent task types: ${topSigs.join(', ')}.`);
    }

    const newSummary = parts.join(' ');
    const summaryChanged = newSummary !== context.memory.lessonsSummary;
    context.memory.lessonsSummary = newSummary;

    // Evict low-signal episodes — keep failures and recent successes
    const highSignal = episodes.filter(
      (e, i) => e.outcome === 'failed' || e.outcome === 'partial' || i < 10,
    );
    const evicted = episodes.length - highSignal.length;
    if (evicted > 0) {
      context.memory.episodes = highSignal;
    }

    return evicted + (summaryChanged ? 1 : 0);
  }

  private refinePersona(context: AgentContext): boolean {
    const profEntries = Object.values(context.skills.proficiencies);
    if (profEntries.length === 0) return false;

    const expertAreas = profEntries.filter((p) => p.level === 'expert');
    const competentAreas = profEntries.filter((p) => p.level === 'competent');

    // Build persona from skill profile
    const traits: string[] = [];

    if (expertAreas.length > 0) {
      const sorted = expertAreas.sort((a, b) => b.totalAttempts - a.totalAttempts);
      if (sorted[0]) traits.push(`${sorted[0].taskSignature} expert`);
    }

    if (expertAreas.length >= 3) {
      traits.push('versatile');
    } else if (expertAreas.length === 1 && competentAreas.length <= 1) {
      traits.push('specialist');
    }

    // Analyze overall success rate
    const totalAttempts = profEntries.reduce((sum, p) => sum + p.totalAttempts, 0);
    const weightedSuccess = profEntries.reduce((sum, p) => sum + p.successRate * p.totalAttempts, 0);
    const overallRate = totalAttempts > 0 ? weightedSuccess / totalAttempts : 0;

    if (overallRate >= 0.85) traits.push('reliable');
    else if (overallRate >= 0.6) traits.push('developing');

    const newPersona = traits.join(', ') || context.identity.persona;
    if (newPersona !== context.identity.persona) {
      context.identity.persona = newPersona;
      return true;
    }
    return false;
  }

  private graduateSkills(context: AgentContext): number {
    let graduated = 0;

    for (const [sig, prof] of Object.entries(context.skills.proficiencies)) {
      let newLevel: SkillLevel = prof.level;

      if (prof.totalAttempts >= 5 && prof.successRate >= 0.8 && prof.level !== 'expert') {
        newLevel = 'expert';
      } else if (prof.totalAttempts >= 3 && prof.successRate >= 0.5 && prof.level === 'novice') {
        newLevel = 'competent';
      }

      // Override with CapabilityModel if available
      if (this.capabilityModel) {
        const cap = this.capabilityModel.getCapabilityByKey(context.identity.agentId, sig);
        if (cap.capability !== null) {
          newLevel = cap.capability >= 0.7 ? 'expert' : cap.capability >= 0.4 ? 'competent' : 'novice';
        }
      }

      if (newLevel !== prof.level) {
        context.skills.proficiencies[sig] = { ...prof, level: newLevel };
        graduated++;
      }
    }

    return graduated;
  }

  private updateCapabilities(context: AgentContext): boolean {
    if (!this.capabilityModel) return false;

    const capabilities = this.capabilityModel.getWorkerCapabilities(context.identity.agentId);
    const strengths: string[] = [];
    const weaknesses: string[] = [];

    for (const cap of capabilities) {
      if (cap.capability === null) continue;
      if (cap.capability >= 0.7) strengths.push(cap.fingerprint);
      else if (cap.negative) weaknesses.push(cap.fingerprint);
    }

    const newStrengths = strengths.slice(0, 8);
    const newWeaknesses = weaknesses.slice(0, 5);

    const changed =
      JSON.stringify(newStrengths) !== JSON.stringify(context.identity.strengths) ||
      JSON.stringify(newWeaknesses) !== JSON.stringify(context.identity.weaknesses);

    if (changed) {
      context.identity.strengths = newStrengths;
      context.identity.weaknesses = newWeaknesses;
    }

    return changed;
  }
}
