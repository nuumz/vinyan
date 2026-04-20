/**
 * AgentContextStore — CRUD persistence for the *machine* side of an
 * agent's context.
 *
 * As of migration 041, narrative sections (persona, strengths, weaknesses,
 * approach style, lessons summary, preferred approaches, anti-patterns)
 * live in `.vinyan/souls/{agentId}.soul.md` (read via `SoulStore`). This
 * store keeps only the non-narrative state:
 *
 *   - proficiencies      → numeric skill stats per task signature
 *   - episodes           → bounded audit log of recent task outcomes
 *   - pending_insights   → per-task queue awaiting sleep-cycle synthesis
 *   - updated_at         → staleness clock
 *
 * `AgentContextBuilder` hydrates the full `AgentContext` shape by merging
 * this machine state with soul-sourced narrative at build time.
 */
import type { Database } from 'bun:sqlite';
import type {
  AgentContext,
  AgentEpisode,
  SkillProficiency,
} from '../orchestrator/agent-context/types.ts';
import { createEmptyContext } from '../orchestrator/agent-context/types.ts';
import type { PendingInsight } from '../orchestrator/agent-context/soul-schema.ts';

interface AgentContextRow {
  agent_id: string;
  episodes: string;
  proficiencies: string;
  updated_at: number;
}

function rowToContext(row: AgentContextRow): AgentContext {
  // Narrative sections are intentionally left empty here; the builder
  // merges them from SoulStore. `createEmptyContext` seeds the
  // non-narrative defaults (e.g. empty strengths list).
  const base = createEmptyContext(row.agent_id);
  return {
    identity: base.identity,
    memory: {
      episodes: JSON.parse(row.episodes) as AgentEpisode[],
      lessonsSummary: base.memory.lessonsSummary, // filled by builder from soul
    },
    skills: {
      proficiencies: JSON.parse(row.proficiencies) as Record<string, SkillProficiency>,
      preferredApproaches: base.skills.preferredApproaches, // filled by builder
      antiPatterns: base.skills.antiPatterns, // filled by builder
    },
    lastUpdated: row.updated_at,
  };
}

export class AgentContextStore {
  private db: Database;
  private upsertStmt;
  private findStmt;

  constructor(db: Database) {
    this.db = db;

    this.upsertStmt = db.prepare(`
      INSERT INTO agent_contexts (
        agent_id, episodes, proficiencies, updated_at
      ) VALUES (
        $agent_id, $episodes, $proficiencies, $updated_at
      )
      ON CONFLICT(agent_id) DO UPDATE SET
        episodes = excluded.episodes,
        proficiencies = excluded.proficiencies,
        updated_at = excluded.updated_at
    `);

    this.findStmt = db.prepare(`SELECT * FROM agent_contexts WHERE agent_id = ?`);
  }

  /**
   * Persist the machine-state slice of an AgentContext. Narrative fields
   * on the argument (persona, strengths, etc.) are IGNORED — they belong
   * to soul.md, not the DB row.
   */
  upsert(context: AgentContext): void {
    this.upsertStmt.run({
      $agent_id: context.identity.agentId,
      $episodes: JSON.stringify(context.memory.episodes),
      $proficiencies: JSON.stringify(context.skills.proficiencies),
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
    const rows = this.db
      .prepare(`SELECT * FROM agent_contexts ORDER BY updated_at DESC`)
      .all() as AgentContextRow[];
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
    // Ensure the row exists first — pending_insights is a column that
    // was added in migration 019; if the agent has no context row yet,
    // insert a seed so the UPDATE has something to land on.
    this.db
      .prepare(
        `INSERT INTO agent_contexts (agent_id, episodes, proficiencies, updated_at)
         VALUES (?, '[]', '{}', ?)
         ON CONFLICT(agent_id) DO NOTHING`,
      )
      .run(agentId, Date.now());
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
