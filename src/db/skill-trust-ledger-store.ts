/**
 * SkillTrustLedgerStore — writer + reader for `skill_trust_ledger`
 * (migration 008).
 *
 * The Skills Hub importer (`src/skills/hub/importer.ts`) writes one row per
 * state transition an imported skill passes through. The importer's
 * governance (promote/demote/reject) is rule-based (A3); this table is the
 * replay log that proves the deterministic decision path.
 *
 * Profile scoping (w1-contracts §3): every read method requires either an
 * explicit profile filter or the explicit `'ALL'` sentinel. Cross-profile
 * reads without the sentinel are refused to prevent accidental leaks.
 */
import type { Database } from 'bun:sqlite';
import type { ConfidenceTier } from '../core/confidence-tier.ts';

export type SkillTrustEvent =
  | 'fetched'
  | 'scanned'
  | 'quarantined'
  | 'dry_run'
  | 'critic_reviewed'
  | 'promoted'
  | 'demoted'
  | 'retired'
  | 'rejected';

export type SkillTrustStatus = 'fetched' | 'quarantined' | 'active' | 'rejected' | 'retired';

export interface SkillTrustLedgerRecord {
  readonly ledgerId?: number;
  readonly profile: string;
  readonly skillId: string;
  readonly event: SkillTrustEvent;
  readonly fromStatus?: SkillTrustStatus;
  readonly toStatus?: SkillTrustStatus;
  readonly fromTier?: ConfidenceTier;
  readonly toTier?: ConfidenceTier;
  readonly evidence: Record<string, unknown>;
  readonly ruleId?: string;
  readonly createdAt: number;
}

export interface SkillTrustLedgerQuery {
  /** Profile to filter on. Pass `'ALL'` to disable the filter (logged-cross-read). */
  readonly profile: string;
  readonly limit?: number;
}

interface SkillTrustLedgerRow {
  ledger_id: number;
  profile: string;
  skill_id: string;
  event: string;
  from_status: string | null;
  to_status: string | null;
  from_tier: string | null;
  to_tier: string | null;
  evidence_json: string;
  rule_id: string | null;
  created_at: number;
}

export class SkillTrustLedgerStore {
  constructor(private readonly db: Database) {}

  /** Append a ledger row. Returns the assigned autoincrement id. */
  record(record: SkillTrustLedgerRecord): number {
    const result = this.db
      .prepare(
        `INSERT INTO skill_trust_ledger
          (profile, skill_id, event, from_status, to_status,
           from_tier, to_tier, evidence_json, rule_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.profile,
        record.skillId,
        record.event,
        record.fromStatus ?? null,
        record.toStatus ?? null,
        record.fromTier ?? null,
        record.toTier ?? null,
        JSON.stringify(record.evidence),
        record.ruleId ?? null,
        record.createdAt,
      );
    return Number(result.lastInsertRowid);
  }

  /** Per-skill history (oldest first). Profile-scoped. */
  history(skillId: string, opts: SkillTrustLedgerQuery): SkillTrustLedgerRecord[] {
    const limit = opts.limit ?? 500;
    const rows =
      opts.profile === 'ALL'
        ? (this.db
            .prepare(
              `SELECT * FROM skill_trust_ledger
                WHERE skill_id = ?
                ORDER BY created_at ASC, ledger_id ASC
                LIMIT ?`,
            )
            .all(skillId, limit) as SkillTrustLedgerRow[])
        : (this.db
            .prepare(
              `SELECT * FROM skill_trust_ledger
                WHERE skill_id = ? AND profile = ?
                ORDER BY created_at ASC, ledger_id ASC
                LIMIT ?`,
            )
            .all(skillId, opts.profile, limit) as SkillTrustLedgerRow[]);
    return rows.map(rowToRecord);
  }

  /** Most-recent event for a skill. Profile-scoped. */
  latest(skillId: string, opts: SkillTrustLedgerQuery): SkillTrustLedgerRecord | null {
    const row =
      opts.profile === 'ALL'
        ? (this.db
            .prepare(
              `SELECT * FROM skill_trust_ledger
                WHERE skill_id = ?
                ORDER BY created_at DESC, ledger_id DESC
                LIMIT 1`,
            )
            .get(skillId) as SkillTrustLedgerRow | null)
        : (this.db
            .prepare(
              `SELECT * FROM skill_trust_ledger
                WHERE skill_id = ? AND profile = ?
                ORDER BY created_at DESC, ledger_id DESC
                LIMIT 1`,
            )
            .get(skillId, opts.profile) as SkillTrustLedgerRow | null);
    return row ? rowToRecord(row) : null;
  }

  /** All ledger rows for a profile (most recent first). For observability. */
  listByProfile(profile: string, limit = 200): SkillTrustLedgerRecord[] {
    const rows =
      profile === 'ALL'
        ? (this.db
            .prepare(
              `SELECT * FROM skill_trust_ledger
                ORDER BY created_at DESC, ledger_id DESC
                LIMIT ?`,
            )
            .all(limit) as SkillTrustLedgerRow[])
        : (this.db
            .prepare(
              `SELECT * FROM skill_trust_ledger
                WHERE profile = ?
                ORDER BY created_at DESC, ledger_id DESC
                LIMIT ?`,
            )
            .all(profile, limit) as SkillTrustLedgerRow[]);
    return rows.map(rowToRecord);
  }
}

function rowToRecord(row: SkillTrustLedgerRow): SkillTrustLedgerRecord {
  const rec: SkillTrustLedgerRecord = {
    ledgerId: row.ledger_id,
    profile: row.profile,
    skillId: row.skill_id,
    event: row.event as SkillTrustEvent,
    evidence: row.evidence_json ? (JSON.parse(row.evidence_json) as Record<string, unknown>) : {},
    createdAt: row.created_at,
    ...(row.from_status ? { fromStatus: row.from_status as SkillTrustStatus } : {}),
    ...(row.to_status ? { toStatus: row.to_status as SkillTrustStatus } : {}),
    ...(row.from_tier ? { fromTier: row.from_tier as ConfidenceTier } : {}),
    ...(row.to_tier ? { toTier: row.to_tier as ConfidenceTier } : {}),
    ...(row.rule_id ? { ruleId: row.rule_id } : {}),
  };
  return rec;
}
