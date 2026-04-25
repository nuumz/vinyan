/**
 * CommonSenseRegistry — SQLite-backed store for defeasible-prior rules.
 *
 * Pattern mirrors `src/db/rule-store.ts`: prepared statements, idempotent
 * insert, content-addressed id, zod-validated row deserialization.
 *
 * Rule application (M2 piece) lives in `oracle.ts`. This file is M1: pure
 * persistence + content-addressing + microtheory query.
 *
 * See `docs/design/commonsense-substrate-system-design.md` §6 / M1.
 */
import type { Database } from 'bun:sqlite';
import { createHash } from 'crypto';
import { evaluatePattern } from './predicate-eval.ts';
import {
  type ApplicationContext,
  type CommonSenseRule,
  type CommonSenseRuleInput,
  CommonSenseRuleInputSchema,
  CommonSenseRuleSchema,
  type MicrotheoryLabel,
  type Pattern,
} from './types.ts';

/**
 * M4 — Priority caps by rule source. Prevents noisy mined rules from
 * outranking carefully-curated innate rules (Stripe Radar / Sift Science /
 * Cloudflare convergent pattern; see design doc Appendix B).
 *
 *  - innate:                priority unchanged (operator-level trust)
 *  - configured:            clamp to [40, 80] (workspace-supplied)
 *  - promoted-from-pattern: clamp to [30, 70] (mined; capped below innate)
 */
const PRIORITY_CAPS: Record<CommonSenseRule['source'], { min: number; max: number }> = {
  innate: { min: 0, max: 100 },
  configured: { min: 40, max: 80 },
  'promoted-from-pattern': { min: 30, max: 70 },
};

function clampPriority(priority: number, source: CommonSenseRule['source']): number {
  const caps = PRIORITY_CAPS[source];
  if (priority < caps.min) return caps.min;
  if (priority > caps.max) return caps.max;
  return priority;
}

/**
 * Compute the content-addressed id for a rule.
 *
 * SHA-256 of the canonical JSON of (microtheory, pattern, default_outcome).
 * Rules differing only in priority/rationale/source still produce the same
 * id — these are metadata, not the rule's identity.
 */
export function computeRuleId(microtheory: MicrotheoryLabel, pattern: Pattern, defaultOutcome: string): string {
  const payload = JSON.stringify({
    microtheory: {
      language: microtheory.language,
      domain: microtheory.domain,
      action: microtheory.action,
    },
    pattern,
    default_outcome: defaultOutcome,
  });
  return createHash('sha256').update(payload).digest('hex');
}

export interface MicrotheoryQuery {
  language: MicrotheoryLabel['language'];
  domain: MicrotheoryLabel['domain'];
  action: MicrotheoryLabel['action'];
}

export class CommonSenseRegistry {
  private db: Database;
  private insertStmt;
  private selectByIdStmt;
  private deleteByIdStmt;
  private countStmt;
  private countBySourceStmt;

  constructor(db: Database) {
    this.db = db;

    this.insertStmt = db.prepare(`
      INSERT OR REPLACE INTO commonsense_rules (
        id, microtheory_lang, microtheory_domain, microtheory_action,
        pattern, default_outcome, abnormality_predicate, priority,
        confidence, source, evidence_hash, promoted_from_pattern_id,
        created_at, rationale
      ) VALUES (
        $id, $lang, $domain, $action,
        $pattern, $default_outcome, $abnormality, $priority,
        $confidence, $source, $evidence_hash, $promoted_from,
        $created_at, $rationale
      )
    `);

    this.selectByIdStmt = db.prepare(`SELECT * FROM commonsense_rules WHERE id = ?`);
    this.deleteByIdStmt = db.prepare(`DELETE FROM commonsense_rules WHERE id = ?`);
    this.countStmt = db.prepare(`SELECT COUNT(*) as cnt FROM commonsense_rules`);
    this.countBySourceStmt = db.prepare(`SELECT COUNT(*) as cnt FROM commonsense_rules WHERE source = ?`);
  }

  /**
   * Insert (or upsert) a rule. Returns the rule with its derived id and
   * created_at. Idempotent: same (microtheory, pattern, default_outcome) →
   * same id → INSERT OR REPLACE updates priority/rationale/source/etc.
   */
  insertRule(input: CommonSenseRuleInput): CommonSenseRule {
    const validated = CommonSenseRuleInputSchema.parse(input);
    const id = computeRuleId(validated.microtheory, validated.pattern, validated.default_outcome);
    const createdAt = Date.now();

    // M4 — priority caps by source. Innate rules keep their author-set priority;
    // configured + promoted-from-pattern rules are clamped so they cannot
    // outrank curated innate rules.
    const cappedPriority = clampPriority(validated.priority, validated.source);

    this.insertStmt.run({
      $id: id,
      $lang: validated.microtheory.language,
      $domain: validated.microtheory.domain,
      $action: validated.microtheory.action,
      $pattern: JSON.stringify(validated.pattern),
      $default_outcome: validated.default_outcome,
      $abnormality: validated.abnormality_predicate ? JSON.stringify(validated.abnormality_predicate) : null,
      $priority: cappedPriority,
      $confidence: validated.confidence,
      $source: validated.source,
      $evidence_hash: validated.evidence_hash ?? null,
      $promoted_from: validated.promoted_from_pattern_id ?? null,
      $created_at: createdAt,
      $rationale: validated.rationale,
    });

    return { ...validated, id, priority: cappedPriority, created_at: createdAt };
  }

  findById(id: string): CommonSenseRule | null {
    const row = this.selectByIdStmt.get(id);
    return row ? rowToRule(row) : null;
  }

  /**
   * Find all rules whose three-axis microtheory label matches the query,
   * with `universal` acting as wildcard on EITHER side. Results are sorted
   * by (priority desc, created_at desc) — Lifschitz prioritized
   * circumscription with most-recent tie-break.
   */
  findApplicable(query: MicrotheoryQuery): CommonSenseRule[] {
    // Three-axis match with universal wildcard.
    const sql = `
      SELECT * FROM commonsense_rules
      WHERE (microtheory_lang = ? OR microtheory_lang = 'universal' OR ? = 'universal')
        AND (microtheory_domain = ? OR microtheory_domain = 'universal' OR ? = 'universal')
        AND (microtheory_action = ? OR microtheory_action = 'universal' OR ? = 'universal')
      ORDER BY priority DESC, created_at DESC
    `;
    const rows = this.db
      .prepare(sql)
      .all(query.language, query.language, query.domain, query.domain, query.action, query.action);
    return rows.map(rowToRule);
  }

  /**
   * Find rules that BOTH match the microtheory query AND fire on the given
   * application context (pattern matches AND abnormality does not hold).
   * The fire-list is the input to the OracleVerdict's evidence chain.
   */
  findFiring(query: MicrotheoryQuery, ctx: ApplicationContext): CommonSenseRule[] {
    const candidates = this.findApplicable(query);
    return candidates.filter((rule) => {
      if (!evaluatePattern(rule.pattern, ctx)) return false;
      if (rule.abnormality_predicate && evaluatePattern(rule.abnormality_predicate, ctx)) {
        return false; // rule fires UNLESS abnormality holds — and it does
      }
      return true;
    });
  }

  deleteById(id: string): boolean {
    const result = this.deleteByIdStmt.run(id);
    return result.changes > 0;
  }

  count(): number {
    const row = this.countStmt.get() as { cnt: number };
    return row.cnt;
  }

  countBySource(source: CommonSenseRule['source']): number {
    const row = this.countBySourceStmt.get(source) as { cnt: number };
    return row.cnt;
  }
}

// ── Row deserialization ──────────────────────────────────────────────────

function rowToRule(row: unknown): CommonSenseRule {
  const r = row as {
    id: string;
    microtheory_lang: string;
    microtheory_domain: string;
    microtheory_action: string;
    pattern: string;
    default_outcome: string;
    abnormality_predicate: string | null;
    priority: number;
    confidence: number;
    source: string;
    evidence_hash: string | null;
    promoted_from_pattern_id: string | null;
    created_at: number;
    rationale: string;
  };

  const parsed = CommonSenseRuleSchema.safeParse({
    id: r.id,
    microtheory: {
      language: r.microtheory_lang,
      domain: r.microtheory_domain,
      action: r.microtheory_action,
    },
    pattern: JSON.parse(r.pattern),
    default_outcome: r.default_outcome,
    abnormality_predicate: r.abnormality_predicate ? JSON.parse(r.abnormality_predicate) : undefined,
    priority: r.priority,
    confidence: r.confidence,
    source: r.source,
    evidence_hash: r.evidence_hash ?? undefined,
    promoted_from_pattern_id: r.promoted_from_pattern_id ?? undefined,
    created_at: r.created_at,
    rationale: r.rationale,
  });

  if (parsed.success) return parsed.data;

  // Schema mismatch → throw with diagnostic. Registry rows MUST round-trip;
  // a failed parse means migration drift or external corruption.
  throw new Error(`CommonSenseRegistry: row failed Zod validation for id=${r.id}: ${parsed.error.message}`);
}
