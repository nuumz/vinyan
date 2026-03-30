/**
 * RuleStore — SQLite persistence for evolutionary rules.
 *
 * CRUD for EvolutionaryRule lifecycle: probation → active → retired.
 *
 * Source of truth: vinyan-tdd.md §2 (Evolution Engine)
 */
import type { Database } from "bun:sqlite";
import type { EvolutionaryRule } from "../orchestrator/types.ts";

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
        status, created_at, effectiveness, specificity, superseded_by
      ) VALUES (
        $id, $source, $condition, $action, $parameters,
        $status, $created_at, $effectiveness, $specificity, $superseded_by
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
      $created_at: rule.created_at,
      $effectiveness: rule.effectiveness,
      $specificity: rule.specificity,
      $superseded_by: rule.superseded_by ?? null,
    });
  }

  findActive(): EvolutionaryRule[] {
    const rows = this.db.prepare(
      `SELECT * FROM evolutionary_rules WHERE status = 'active' ORDER BY specificity DESC, effectiveness DESC`,
    ).all();
    return rows.map(rowToRule);
  }

  findByStatus(status: EvolutionaryRule["status"]): EvolutionaryRule[] {
    const rows = this.db.prepare(
      `SELECT * FROM evolutionary_rules WHERE status = ? ORDER BY created_at DESC`,
    ).all(status);
    return rows.map(rowToRule);
  }

  /**
   * Find rules whose conditions match the given context.
   * A rule matches if ALL its non-null conditions match.
   */
  findMatching(context: RuleMatchContext): EvolutionaryRule[] {
    const active = this.findActive();
    return active.filter(rule => matchesContext(rule, context));
  }

  updateEffectiveness(id: string, effectiveness: number): void {
    this.db.prepare(
      `UPDATE evolutionary_rules SET effectiveness = ? WHERE id = ?`,
    ).run(effectiveness, id);
  }

  retire(id: string, supersededBy?: string): void {
    this.db.prepare(
      `UPDATE evolutionary_rules SET status = 'retired', superseded_by = ? WHERE id = ?`,
    ).run(supersededBy ?? null, id);
  }

  activate(id: string): void {
    this.db.prepare(
      `UPDATE evolutionary_rules SET status = 'active' WHERE id = ?`,
    ).run(id);
  }

  count(): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM evolutionary_rules`,
    ).get() as { cnt: number };
    return row.cnt;
  }

  countByStatus(status: EvolutionaryRule["status"]): number {
    const row = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM evolutionary_rules WHERE status = ?`,
    ).get(status) as { cnt: number };
    return row.cnt;
  }
}

// ── Matching logic ───────────────────────────────────────────────────────

function matchesContext(rule: EvolutionaryRule, context: RuleMatchContext): boolean {
  const c = rule.condition;

  if (c.file_pattern && context.filePattern) {
    if (!matchGlob(c.file_pattern, context.filePattern)) return false;
  } else if (c.file_pattern && !context.filePattern) {
    return false;
  }

  if (c.oracle_name && context.oracleName) {
    if (c.oracle_name !== context.oracleName) return false;
  } else if (c.oracle_name && !context.oracleName) {
    return false;
  }

  if (c.risk_above !== undefined && context.riskScore !== undefined) {
    if (context.riskScore <= c.risk_above) return false;
  } else if (c.risk_above !== undefined && context.riskScore === undefined) {
    return false;
  }

  if (c.model_pattern && context.modelPattern) {
    if (!context.modelPattern.includes(c.model_pattern)) return false;
  } else if (c.model_pattern && !context.modelPattern) {
    return false;
  }

  return true;
}

/** Simple glob matching — supports * wildcard only. */
function matchGlob(pattern: string, value: string): boolean {
  const regex = new RegExp(
    "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$",
  );
  return regex.test(value);
}

// ── Row deserialization ──────────────────────────────────────────────────

function rowToRule(row: any): EvolutionaryRule {
  return {
    id: row.id,
    source: row.source,
    condition: JSON.parse(row.condition),
    action: row.action,
    parameters: JSON.parse(row.parameters),
    status: row.status,
    created_at: row.created_at,
    effectiveness: row.effectiveness,
    specificity: row.specificity,
    superseded_by: row.superseded_by ?? undefined,
  };
}
