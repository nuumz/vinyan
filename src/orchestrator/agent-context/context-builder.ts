/**
 * AgentContextBuilder — assembles AgentContext by merging:
 *
 *   1. **Machine state** from AgentContextStore (proficiencies, episodes,
 *      pending_insights).
 *   2. **Narrative** from SoulStore (`.vinyan/souls/{agentId}.soul.md`):
 *      persona, approach style, lessons summary, anti-patterns, preferred
 *      approaches.
 *   3. **Derived strengths/weaknesses** from CapabilityModel (runtime).
 *
 * After migration 041, the DB no longer stores narrative columns — soul.md
 * is the authoritative source for every human-readable section. Cold-start
 * agents (no soul, no traces) get empty narratives; trace-driven fallbacks
 * remain so a soulless agent can still offer a reasonable persona.
 *
 * Source: docs/plans/sqlite-joyful-lynx.md §Phase 5.
 */
import type { Database } from 'bun:sqlite';
import type { AgentContextStore } from '../../db/agent-context-store.ts';
import type { CapabilityModel, CapabilityScore } from '../fleet/capability-model.ts';
import type { SoulStore } from './soul-store.ts';
import type { SoulDocument } from './soul-schema.ts';
import { type AgentContext, type AgentEpisode, MAX_EPISODES, createEmptyContext } from './types.ts';

/** Lightweight trace projection — only the fields we need for cold-start derivation. */
interface TraceProjection {
  taskId: string;
  workerId?: string;
  timestamp: number;
  approach: string;
  taskTypeSignature?: string;
  oracleVerdicts: Record<string, boolean>;
  durationMs: number;
  outcome: 'success' | 'failure' | 'timeout' | 'escalated';
  failureReason?: string;
  affectedFiles: string[];
}

export interface AgentContextBuilderDeps {
  agentContextStore: AgentContextStore;
  capabilityModel?: CapabilityModel;
  /** Direct DB access for ad-hoc queries (e.g. recent traces by worker). */
  db?: Database;
  /**
   * Optional soul store. When present, narrative sections (persona,
   * approach style, anti-patterns, lessons summary, preferred approaches)
   * are hydrated from `.vinyan/souls/{agentId}.soul.md`. Absent → builder
   * falls back to trace-derived narrative (cold-start path).
   */
  soulStore?: SoulStore;
}

export class AgentContextBuilder {
  private store: AgentContextStore;
  private capabilityModel?: CapabilityModel;
  private db?: Database;
  private soulStore?: SoulStore;

  constructor(deps: AgentContextBuilderDeps) {
    this.store = deps.agentContextStore;
    this.capabilityModel = deps.capabilityModel;
    this.db = deps.db;
    this.soulStore = deps.soulStore;
  }

  /**
   * Build the full AgentContext. The machine slice (episodes + proficiencies)
   * comes from the DB; strengths/weaknesses from CapabilityModel; narrative
   * from soul.md. When no soul exists, fall back to trace-derived narrative
   * so cold-start agents still get a usable persona.
   */
  buildContext(agentId: string): AgentContext {
    const machine = this.store.findOrCreate(agentId);
    const soul = this.soulStore?.loadSoul(agentId) ?? null;

    // Derived strengths/weaknesses — runtime, not persisted in DB.
    let strengths: string[] = [];
    let weaknesses: string[] = [];
    if (this.capabilityModel) {
      const capabilities = this.capabilityModel.getWorkerCapabilities(agentId);
      const derived = this.deriveFromCapabilities(capabilities);
      strengths = derived.strengths;
      weaknesses = derived.weaknesses;
    }

    // Hydrate narrative from soul.md when available; otherwise fall back
    // to trace-derived so a newly-spawned agent without a soul still has
    // a reasonable persona string.
    const narrative = soul
      ? this.narrativeFromSoul(soul)
      : this.narrativeFromTraces(agentId);

    const merged: AgentContext = {
      identity: {
        agentId,
        persona: narrative.persona,
        strengths,
        weaknesses,
        approachStyle: narrative.approachStyle,
      },
      memory: {
        episodes:
          machine.memory.episodes.length > 0
            ? machine.memory.episodes
            : this.seedEpisodesFromTraces(agentId),
        lessonsSummary: narrative.lessonsSummary,
      },
      skills: {
        proficiencies: machine.skills.proficiencies,
        preferredApproaches: narrative.preferredApproaches,
        antiPatterns: narrative.antiPatterns,
      },
      lastUpdated: machine.lastUpdated || Date.now(),
    };

    // Persist the episode-seed back so cold-start trace derivation is a
    // one-time cost per agent. Narrative fields are NOT persisted — soul.md
    // is the home for them.
    if (
      (machine.memory.episodes.length === 0 && merged.memory.episodes.length > 0) ||
      Object.keys(merged.skills.proficiencies).length !==
        Object.keys(machine.skills.proficiencies).length
    ) {
      merged.lastUpdated = Date.now();
      this.store.upsert(merged);
    }

    return merged;
  }

  /**
   * Map a SoulDocument's sections onto AgentContext narrative fields.
   * Intentionally loose — soul and context don't map 1:1:
   *
   *   - persona            ← soul.philosophy (first "paragraph")
   *   - approachStyle      ← soul.selfKnowledge (joined)
   *   - lessonsSummary     ← soul.domainExpertise bullets joined
   *   - antiPatterns       ← soul.antiPatterns[].description
   *   - preferredApproaches← soul.winningStrategies indexed by description (legacy shape kept
   *                          empty-ish because winning strategies don't carry a taskSignature)
   */
  private narrativeFromSoul(soul: SoulDocument): {
    persona: string;
    approachStyle: string;
    lessonsSummary: string;
    antiPatterns: string[];
    preferredApproaches: Record<string, string>;
  } {
    const lessons = soul.domainExpertise
      .map((d) => `${d.area}: ${d.knowledge}`)
      .join('; ');
    const anti = soul.antiPatterns.map((a) => `${a.pattern} — ${a.cause}`);
    const preferred: Record<string, string> = {};
    for (const s of soul.winningStrategies) {
      preferred[s.taskPattern] = s.strategy;
    }
    return {
      persona: soul.philosophy,
      approachStyle: soul.selfKnowledge.join('; '),
      lessonsSummary: lessons,
      antiPatterns: anti,
      preferredApproaches: preferred,
    };
  }

  /**
   * Trace-derived fallback narrative for agents without a soul. Mirrors
   * the pre-migration cold-start path — persona + approach style come
   * from analyzing recent traces.
   */
  private narrativeFromTraces(agentId: string): {
    persona: string;
    approachStyle: string;
    lessonsSummary: string;
    antiPatterns: string[];
    preferredApproaches: Record<string, string>;
  } {
    const empty = {
      persona: '',
      approachStyle: '',
      lessonsSummary: '',
      antiPatterns: [] as string[],
      preferredApproaches: {} as Record<string, string>,
    };
    if (!this.db) return empty;
    const recentTraces = this.loadRecentTraces(agentId, 20);
    if (recentTraces.length === 0) return empty;
    return {
      persona: this.derivePersona(recentTraces),
      approachStyle: this.deriveApproachStyle(recentTraces),
      lessonsSummary: '',
      antiPatterns: [],
      preferredApproaches: {},
    };
  }

  private seedEpisodesFromTraces(agentId: string): AgentEpisode[] {
    if (!this.db) return [];
    const recent = this.loadRecentTraces(agentId, 20);
    if (recent.length === 0) return [];
    return this.tracesToEpisodes(recent).slice(0, MAX_EPISODES);
  }

  private deriveFromCapabilities(capabilities: CapabilityScore[]): {
    strengths: string[];
    weaknesses: string[];
  } {
    const strengths: string[] = [];
    const weaknesses: string[] = [];

    for (const cap of capabilities) {
      if (cap.capability === null) continue; // insufficient data (A2)

      if (cap.capability >= 0.7) {
        strengths.push(cap.fingerprint);
      } else if (cap.negative) {
        weaknesses.push(cap.fingerprint);
      }
    }

    return { strengths: strengths.slice(0, 8), weaknesses: weaknesses.slice(0, 5) };
  }

  private loadRecentTraces(agentId: string, limit: number): TraceProjection[] {
    if (!this.db) return [];
    try {
      // Multi-agent: prefer specialist id (agent_id) over oracle id
      // (worker_id). The OR clause keeps pre-migration rows readable
      // during the rollout window.
      const rows = this.db
        .prepare(
          `SELECT task_id, worker_id, timestamp, approach, task_type_signature,
                  oracle_verdicts, duration_ms, outcome, failure_reason, affected_files
           FROM execution_traces
           WHERE (agent_id = ? OR (agent_id IS NULL AND worker_id = ?))
           ORDER BY timestamp DESC LIMIT ?`,
        )
        .all(agentId, agentId, limit) as Array<Record<string, unknown>>;

      return rows.map((row) => ({
        taskId: row.task_id as string,
        workerId: row.worker_id as string | undefined,
        timestamp: row.timestamp as number,
        approach: (row.approach as string) ?? '',
        taskTypeSignature: row.task_type_signature as string | undefined,
        oracleVerdicts: row.oracle_verdicts ? JSON.parse(row.oracle_verdicts as string) : {},
        durationMs: row.duration_ms as number,
        outcome: row.outcome as TraceProjection['outcome'],
        failureReason: row.failure_reason as string | undefined,
        affectedFiles: row.affected_files ? JSON.parse(row.affected_files as string) : [],
      }));
    } catch {
      return [];
    }
  }

  private derivePersona(traces: TraceProjection[]): string {
    const successCount = traces.filter((t) => t.outcome === 'success').length;
    const total = traces.length;
    const successRate = total > 0 ? successCount / total : 0;

    // Analyze task type diversity
    const taskTypes = new Set(traces.map((t) => t.taskTypeSignature).filter(Boolean));
    const isSpecialist = taskTypes.size <= 2 && total >= 5;
    const isGeneralist = taskTypes.size >= 4;

    // Analyze approach style
    const avgDuration = traces.reduce((sum, t) => sum + t.durationMs, 0) / total;
    const isThorough = avgDuration > 15_000;

    const traits: string[] = [];
    if (successRate >= 0.8) traits.push('reliable');
    else if (successRate >= 0.5) traits.push('developing');

    if (isSpecialist) {
      const topType = [...taskTypes][0] ?? 'tasks';
      traits.push(`${topType} specialist`);
    } else if (isGeneralist) {
      traits.push('generalist');
    }

    if (isThorough) traits.push('thorough');
    else traits.push('quick');

    return traits.join(', ') || 'new agent';
  }

  private deriveApproachStyle(traces: TraceProjection[]): string {
    const successes = traces.filter((t) => t.outcome === 'success');
    if (successes.length === 0) return '';

    // Look for patterns in successful approaches
    const approaches = successes.map((t) => t.approach).filter(Boolean);
    if (approaches.length === 0) return '';

    // Find the most common approach pattern
    const wordFreq = new Map<string, number>();
    for (const approach of approaches) {
      const words = approach.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
      for (const word of words) {
        wordFreq.set(word, (wordFreq.get(word) ?? 0) + 1);
      }
    }

    const topWords = [...wordFreq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([w]) => w);

    if (topWords.length > 0) {
      return `tends to focus on: ${topWords.join(', ')}`;
    }
    return '';
  }

  private tracesToEpisodes(traces: TraceProjection[]): AgentEpisode[] {
    return traces.map((trace) => ({
      taskId: trace.taskId,
      taskSignature: trace.taskTypeSignature ?? 'unknown',
      outcome: trace.outcome === 'success' ? 'success' : trace.outcome === 'escalated' ? 'partial' : 'failed',
      lesson: this.extractLesson(trace),
      filesInvolved: trace.affectedFiles ?? [],
      approachUsed: trace.approach ?? '',
      timestamp: trace.timestamp,
    }));
  }

  private extractLesson(trace: TraceProjection): string {
    if (trace.outcome === 'success') {
      const oracleCount = Object.keys(trace.oracleVerdicts ?? {}).length;
      return `Completed successfully${oracleCount > 0 ? ` (${oracleCount} oracles passed)` : ''}.`;
    }

    if (trace.failureReason) {
      return `Failed: ${trace.failureReason.slice(0, 120)}`;
    }

    const failedOracles = Object.entries(trace.oracleVerdicts ?? {})
      .filter(([, v]) => !v)
      .map(([k]) => k);

    if (failedOracles.length > 0) {
      return `Failed oracles: ${failedOracles.join(', ')}`;
    }

    return `Outcome: ${trace.outcome}`;
  }
}
