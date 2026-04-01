/**
 * RuleStore — SQLite persistence for evolutionary rules.
 *
 * CRUD for EvolutionaryRule lifecycle: probation → active → retired.
 *
 * Source of truth: spec/tdd.md §2 (Evolution Engine)
 */
import type { Database } from 'bun:sqlite';
import { simpleGlobMatch } from '../core/glob.ts';
import type { EvolutionaryRule } from '../orchestrator/types.ts';
import { EvolutionaryRuleRowSchema } from './schemas.ts';

export interface RuleMatchContext {
  filePattern?: string;
  oracleName?: string;
  riskScore?: number;
  modelPattern?: string;
}

export class RuleStore {
  private db: Database;
  private insertStmt;

  constructor(db: Database) {
    this.db = db;
    this.insertStmt = db.prepare(`
      INSERT OR REPLACE INTO evolutionary_rules (
        id, source, condition, action, parameters,
        status, created_at, effectiveness, specificity, superseded_by, origin
      ) VALUES (
        $id, $source, $condition, $action, $parameters,
        $status, $created_at, $effectiveness, $specificity, $superseded_by, $origin
      )
    `);
  }

  insert(rule: EvolutionaryRule): void {
    this.insertStmt.run({
      $id: rule.id,
      $source: rule.source,
      $condition: JSON.stringify(rule.condition),
      $action: rule.action,
      $parameters: JSON.stringify(rule.parameters),
      $status: rule.status,
      $created_at: rule.createdAt,
      $effectiveness: rule.effectiveness,
      $specificity: rule.specificity,
      $superseded_by: rule.supersededBy ?? null,
      $origin: rule.origin ?? 'local',
    });
  }

  findActive(): EvolutionaryRule[] {
    const rows = this.db
      .prepare(`SELECT * FROM evolutionary_rules WHERE status = 'active' ORDER BY specificity DESC, effectiveness DESC`)
      .all();
    return rows.map(rowToRule);
  }

  findByStatus(status: EvolutionaryRule['status']): EvolutionaryRule[] {
    const rows = this.db
      .prepare(`SELECT * FROM evolutionary_rules WHERE status = ? ORDER BY created_at DESC`)
      .all(status);
    return rows.map(rowToRule);
  }

  /**
   * Find rules whose conditions match the given context.
   * A rule matches if ALL its non-null conditions match.
   */
  findMatching(context: RuleMatchContext): EvolutionaryRule[] {
    const active = this.findActive();
    return active.filter((rule) => matchesContext(rule, context));
  }

  updateEffectiveness(id: string, effectiveness: number): void {
    this.db.prepare(`UPDATE evolutionary_rules SET effectiveness = ? WHERE id = ?`).run(effectiveness, id);
  }

  retire(id: string, supersededBy?: string): void {
    this.db
      .prepare(`UPDATE evolutionary_rules SET status = 'retired', superseded_by = ? WHERE id = ?`)
      .run(supersededBy ?? null, id);
  }

  activate(id: string): void {
    this.db.prepare(`UPDATE evolutionary_rules SET status = 'active' WHERE id = ?`).run(id);
  }

  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM evolutionary_rules`).get() as { cnt: number };
    return row.cnt;
  }

  countByStatus(status: EvolutionaryRule['status']): number {
    const row = this.db.prepare(`SELECT COUNT(*) as cnt FROM evolutionary_rules WHERE status = ?`).get(status) as {
      cnt: number;
    };
    return row.cnt;
  }
}

// ── Matching logic ───────────────────────────────────────────────────────

function matchesContext(rule: EvolutionaryRule, context: RuleMatchContext): boolean {
  const c = rule.condition;

  if (c.filePattern && context.filePattern) {
    if (!simpleGlobMatch(c.filePattern, context.filePattern)) return false;
  } else if (c.filePattern && !context.filePattern) {
    return false;
  }

  if (c.oracleName && context.oracleName) {
    if (c.oracleName !== context.oracleName) return false;
  } else if (c.oracleName && !context.oracleName) {
    return false;
  }

  if (c.riskAbove !== undefined && context.riskScore !== undefined) {
    if (context.riskScore <= c.riskAbove) return false;
  } else if (c.riskAbove !== undefined && context.riskScore === undefined) {
    return false;
  }

  if (c.modelPattern && context.modelPattern) {
    if (!context.modelPattern.includes(c.modelPattern)) return false;
  } else if (c.modelPattern && !context.modelPattern) {
    return false;
  }

  return true;
}

// ── Row deserialization ──────────────────────────────────────────────────

function rowToRule(row: unknown): EvolutionaryRule {
  const parsed = EvolutionaryRuleRowSchema.safeParse(row);
  if (parsed.success) {
    return parsed.data as EvolutionaryRule;
  }
  // Fallback: best-effort deserialization (log warning for observability)
  console.warn('[vinyan] RuleStore: row failed Zod validation, using fallback', parsed.error.message);
  const r = row as any;
  return {
    id: r.id,
    source: r.source,
    condition: JSON.parse(r.condition),
    action: r.action,
    parameters: JSON.parse(r.parameters),
    status: r.status,
    createdAt: r.created_at,
    effectiveness: r.effectiveness,
    specificity: r.specificity,
    supersededBy: r.superseded_by ?? undefined,
    origin: r.origin ?? 'local',
  };
}
