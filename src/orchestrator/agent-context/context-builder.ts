/**
 * AgentContextBuilder — assembles AgentContext from DB + existing models.
 *
 * For agents WITH existing context: loads from AgentContextStore.
 * For cold-start agents (no prior context): derives initial identity from
 * CapabilityModel scores and recent traces, following A2 ("I don't know"
 * is valid — cold-start agents get minimal, honest context).
 *
 * Source of truth: ultraplan — Agent Contextual Redesign, Phase 2
 */
import type { Database } from 'bun:sqlite';
import type { AgentContextStore } from '../../db/agent-context-store.ts';
import type { CapabilityModel, CapabilityScore } from '../fleet/capability-model.ts';
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
}

export class AgentContextBuilder {
  private store: AgentContextStore;
  private capabilityModel?: CapabilityModel;
  private db?: Database;

  constructor(deps: AgentContextBuilderDeps) {
    this.store = deps.agentContextStore;
    this.capabilityModel = deps.capabilityModel;
    this.db = deps.db;
  }

  /**
   * Build context for an agent. Returns persisted context if available,
   * otherwise derives initial context from capability data and traces.
   */
  buildContext(agentId: string): AgentContext {
    const existing = this.store.findById(agentId);
    if (existing && existing.identity.persona !== '') {
      return existing;
    }

    // Cold-start: derive from existing data sources
    return this.deriveColdStartContext(agentId);
  }

  private deriveColdStartContext(agentId: string): AgentContext {
    const context = createEmptyContext(agentId);

    // Derive strengths/weaknesses from CapabilityModel
    if (this.capabilityModel) {
      const capabilities = this.capabilityModel.getWorkerCapabilities(agentId);
      const { strengths, weaknesses } = this.deriveFromCapabilities(capabilities);
      context.identity.strengths = strengths;
      context.identity.weaknesses = weaknesses;
    }

    // Derive persona and approach style from recent traces
    if (this.db) {
      const recentTraces = this.loadRecentTraces(agentId, 20);
      if (recentTraces.length > 0) {
        context.identity.persona = this.derivePersona(recentTraces);
        context.identity.approachStyle = this.deriveApproachStyle(recentTraces);

        // Seed episodic memory from recent traces
        const episodes = this.tracesToEpisodes(recentTraces);
        context.memory.episodes = episodes.slice(0, MAX_EPISODES);
      }
    }

    // If we derived anything useful, persist for next time
    if (context.identity.strengths.length > 0 || context.memory.episodes.length > 0) {
      context.lastUpdated = Date.now();
      this.store.upsert(context);
    }

    return context;
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
      const rows = this.db
        .prepare(
          `SELECT task_id, worker_id, timestamp, approach, task_type_signature,
                  oracle_verdicts, duration_ms, outcome, failure_reason, affected_files
           FROM execution_traces WHERE worker_id = ? ORDER BY timestamp DESC LIMIT ?`,
        )
        .all(agentId, limit) as Array<Record<string, unknown>>;

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
