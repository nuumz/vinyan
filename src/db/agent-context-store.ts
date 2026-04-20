/**
 * AgentContextStore — CRUD persistence for agent contexts in SQLite.
 *
 * Follows the same pattern as WorkerStore / PatternStore:
 *   - Constructor receives Database instance from VinyanDB
 *   - Prepared statements for hot-path operations
 *   - JSON serialization for compound fields
 *
 * Source of truth: ultraplan — Agent Contextual Redesign, Phase 1
 */
import type { Database } from 'bun:sqlite';
import type {
  AgentContext,
  AgentEpisode,
  AgentIdentity,
  EpisodicMemory,
  LearnedSkills,
  SkillProficiency,
} from '../orchestrator/agent-context/types.ts';
import { createEmptyContext } from '../orchestrator/agent-context/types.ts';
import type { PendingInsight } from '../orchestrator/agent-context/soul-schema.ts';

interface AgentContextRow {
  agent_id: string;
  persona: string;
  strengths: string;
  weaknesses: string;
  approach_style: string;
  episodes: string;
  lessons_summary: string;
  proficiencies: string;
  preferred_approaches: string;
  anti_patterns: string;
  updated_at: number;
}

function rowToContext(row: AgentContextRow): AgentContext {
  const identity: AgentIdentity = {
    agentId: row.agent_id,
    persona: row.persona,
    strengths: JSON.parse(row.strengths) as string[],
    weaknesses: JSON.parse(row.weaknesses) as string[],
    approachStyle: row.approach_style,
  };

  const memory: EpisodicMemory = {
    episodes: JSON.parse(row.episodes) as AgentEpisode[],
    lessonsSummary: row.lessons_summary,
  };

  const skills: LearnedSkills = {
    proficiencies: JSON.parse(row.proficiencies) as Record<string, SkillProficiency>,
    preferredApproaches: JSON.parse(row.preferred_approaches) as Record<string, string>,
    antiPatterns: JSON.parse(row.anti_patterns) as string[],
  };

  return { identity, memory, skills, lastUpdated: row.updated_at };
}

export class AgentContextStore {
  private db: Database;
  private upsertStmt;
  private findStmt;

  constructor(db: Database) {
    this.db = db;

    this.upsertStmt = db.prepare(`
      INSERT INTO agent_contexts (
        agent_id, persona, strengths, weaknesses, approach_style,
        episodes, lessons_summary, proficiencies, preferred_approaches,
        anti_patterns, updated_at
      ) VALUES (
        $agent_id, $persona, $strengths, $weaknesses, $approach_style,
        $episodes, $lessons_summary, $proficiencies, $preferred_approaches,
        $anti_patterns, $updated_at
      )
      ON CONFLICT(agent_id) DO UPDATE SET
        persona = excluded.persona,
        strengths = excluded.strengths,
        weaknesses = excluded.weaknesses,
        approach_style = excluded.approach_style,
        episodes = excluded.episodes,
        lessons_summary = excluded.lessons_summary,
        proficiencies = excluded.proficiencies,
        preferred_approaches = excluded.preferred_approaches,
        anti_patterns = excluded.anti_patterns,
        updated_at = excluded.updated_at
    `);

    this.findStmt = db.prepare(`SELECT * FROM agent_contexts WHERE agent_id = ?`);
  }

  upsert(context: AgentContext): void {
    this.upsertStmt.run({
      $agent_id: context.identity.agentId,
      $persona: context.identity.persona,
      $strengths: JSON.stringify(context.identity.strengths),
      $weaknesses: JSON.stringify(context.identity.weaknesses),
      $approach_style: context.identity.approachStyle,
      $episodes: JSON.stringify(context.memory.episodes),
      $lessons_summary: context.memory.lessonsSummary,
      $proficiencies: JSON.stringify(context.skills.proficiencies),
      $preferred_approaches: JSON.stringify(context.skills.preferredApproaches),
      $anti_patterns: JSON.stringify(context.skills.antiPatterns),
      $updated_at: context.lastUpdated,
    });
  }

  findById(agentId: string): AgentContext | null {
    const row = this.findStmt.get(agentId) as AgentContextRow | null;
    return row ? rowToContext(row) : null;
  }

  /** Load context or return empty for cold-start agents. */
  findOrCreate(agentId: string): AgentContext {
    return this.findById(agentId) ?? createEmptyContext(agentId);
  }

  findAll(): AgentContext[] {
    const rows = this.db.prepare(`SELECT * FROM agent_contexts ORDER BY updated_at DESC`).all() as AgentContextRow[];
    return rows.map(rowToContext);
  }

  delete(agentId: string): void {
    this.db.prepare(`DELETE FROM agent_contexts WHERE agent_id = ?`).run(agentId);
  }

  // ── Soul: pending insights for LLM reflection ─────────────────────

  /** Append a pending insight from per-task reflection. */
  appendPendingInsight(agentId: string, insight: PendingInsight): void {
    const existing = this.getPendingInsights(agentId);
    existing.push(insight);
    this.db
      .prepare(`UPDATE agent_contexts SET pending_insights = ? WHERE agent_id = ?`)
      .run(JSON.stringify(existing), agentId);
  }

  /** Get all pending insights for an agent. */
  getPendingInsights(agentId: string): PendingInsight[] {
    const row = this.db
      .prepare(`SELECT pending_insights FROM agent_contexts WHERE agent_id = ?`)
      .get(agentId) as { pending_insights: string } | null;
    if (!row) return [];
    try {
      return JSON.parse(row.pending_insights) as PendingInsight[];
    } catch {
      return [];
    }
  }

  /** Clear pending insights after sleep cycle synthesis. */
  clearPendingInsights(agentId: string): void {
    this.db
      .prepare(`UPDATE agent_contexts SET pending_insights = '[]' WHERE agent_id = ?`)
      .run(agentId);
  }

}
