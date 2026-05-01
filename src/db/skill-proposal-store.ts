/**
 * SkillProposalStore — read/write surface for `skill_proposals`
 * (migration 029).
 *
 * Purpose: agent-managed skill creation as procedural memory. Every
 * proposal lives in a quarantine bucket until a human approves it
 * (A6 / A8). No code path here calls an LLM — generation logic happens
 * outside the store; this file is pure CRUD + A3 deterministic
 * lifecycle transitions.
 *
 * Profile scoping: every read takes a `profile` argument. Cross-profile
 * reads are not supported (admin endpoints can iterate over profiles
 * explicitly).
 */
import type { Database } from 'bun:sqlite';
import { memorySafetyVerdict } from '../memory/snapshot.ts';

export type SkillProposalStatus = 'pending' | 'approved' | 'rejected' | 'quarantined';
export type SkillProposalTrust = 'quarantined' | 'community' | 'trusted' | 'official' | 'builtin';

export interface SkillProposal {
  readonly id: string;
  readonly profile: string;
  readonly status: SkillProposalStatus;
  readonly proposedName: string;
  readonly proposedCategory: string;
  readonly skillMd: string;
  readonly capabilityTags: ReadonlyArray<string>;
  readonly toolsRequired: ReadonlyArray<string>;
  readonly sourceTaskIds: ReadonlyArray<string>;
  readonly evidenceEventIds: ReadonlyArray<string>;
  readonly successCount: number;
  readonly safetyFlags: ReadonlyArray<string>;
  readonly trustTier: SkillProposalTrust;
  readonly createdAt: number;
  readonly decidedAt: number | null;
  readonly decidedBy: string | null;
  readonly decisionReason: string | null;
}

export interface CreateSkillProposalInput {
  readonly id?: string;
  readonly profile: string;
  readonly proposedName: string;
  readonly proposedCategory: string;
  readonly skillMd: string;
  readonly capabilityTags?: ReadonlyArray<string>;
  readonly toolsRequired?: ReadonlyArray<string>;
  readonly sourceTaskIds?: ReadonlyArray<string>;
  readonly evidenceEventIds?: ReadonlyArray<string>;
  readonly successCount?: number;
}

export interface ListSkillProposalsOptions {
  readonly status?: SkillProposalStatus;
  readonly limit?: number;
}

interface SkillProposalRow {
  id: string;
  profile: string;
  status: string;
  proposed_name: string;
  proposed_category: string;
  skill_md: string;
  capability_tags: string;
  tools_required: string;
  source_task_ids: string;
  evidence_event_ids: string;
  success_count: number;
  safety_flags: string;
  trust_tier: string;
  created_at: number;
  decided_at: number | null;
  decided_by: string | null;
  decision_reason: string | null;
}

export class SkillProposalStore {
  constructor(private readonly db: Database) {}

  /**
   * Create a proposal. Runs the safety scanner against the SKILL.md
   * draft; any flagged content lands the proposal in the
   * `quarantined` bucket immediately so the operator sees the
   * review hint in the UI without ever loading the dangerous
   * artifact at runtime.
   *
   * Returns the persisted row. Idempotent on `(profile, proposedName)`
   * — re-creating a proposal with the same name updates `successCount`,
   * appends new source ids, and refreshes the SKILL.md draft. The
   * lifecycle status stays as-is so an already-approved skill cannot
   * regress to `pending`.
   */
  create(input: CreateSkillProposalInput): SkillProposal {
    const now = Date.now();
    const id = input.id ?? cryptoRandomId();
    const verdict = memorySafetyVerdict(input.skillMd);
    // Hard-block credential / hidden-unicode flagged content; they
    // never become an approvable proposal. The row is still recorded
    // so audit can replay why the agent tried to propose it (A8).
    const status: SkillProposalStatus = verdict.safe ? 'pending' : 'quarantined';
    const trustTier: SkillProposalTrust = 'quarantined';

    const existing = this.findByName(input.profile, input.proposedName);
    if (existing) {
      // Idempotent merge — preserve approved/rejected status.
      const mergedSourceIds = Array.from(
        new Set([...existing.sourceTaskIds, ...(input.sourceTaskIds ?? [])]),
      );
      const mergedEventIds = Array.from(
        new Set([...existing.evidenceEventIds, ...(input.evidenceEventIds ?? [])]),
      );
      const successCount = existing.successCount + (input.successCount ?? 1);
      const skillMd = input.skillMd;
      const safetyFlags = verdict.flags;
      const nextStatus =
        existing.status === 'approved' || existing.status === 'rejected'
          ? existing.status
          : verdict.safe
            ? existing.status === 'quarantined' && verdict.safe
              ? 'pending'
              : existing.status
            : 'quarantined';
      this.db
        .prepare(
          `UPDATE skill_proposals
              SET skill_md = ?,
                  capability_tags = ?,
                  tools_required = ?,
                  source_task_ids = ?,
                  evidence_event_ids = ?,
                  success_count = ?,
                  safety_flags = ?,
                  status = ?
            WHERE id = ? AND profile = ?`,
        )
        .run(
          skillMd,
          JSON.stringify(input.capabilityTags ?? existing.capabilityTags),
          JSON.stringify(input.toolsRequired ?? existing.toolsRequired),
          JSON.stringify(mergedSourceIds),
          JSON.stringify(mergedEventIds),
          successCount,
          JSON.stringify(safetyFlags),
          nextStatus,
          existing.id,
          existing.profile,
        );
      const after = this.get(existing.id, existing.profile);
      if (after) return after;
    }

    this.db
      .prepare(
        `INSERT INTO skill_proposals
           (id, profile, status, proposed_name, proposed_category, skill_md,
            capability_tags, tools_required, source_task_ids, evidence_event_ids,
            success_count, safety_flags, trust_tier, created_at,
            decided_at, decided_by, decision_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      )
      .run(
        id,
        input.profile,
        status,
        input.proposedName,
        input.proposedCategory,
        input.skillMd,
        JSON.stringify(input.capabilityTags ?? []),
        JSON.stringify(input.toolsRequired ?? []),
        JSON.stringify(input.sourceTaskIds ?? []),
        JSON.stringify(input.evidenceEventIds ?? []),
        input.successCount ?? 1,
        JSON.stringify(verdict.flags),
        trustTier,
        now,
      );
    const row = this.get(id, input.profile);
    if (!row) throw new Error('SkillProposalStore: insert failed to round-trip');
    return row;
  }

  get(id: string, profile: string): SkillProposal | null {
    const row = this.db
      .prepare(`SELECT * FROM skill_proposals WHERE id = ? AND profile = ?`)
      .get(id, profile) as SkillProposalRow | null;
    return row ? rowToProposal(row) : null;
  }

  findByName(profile: string, proposedName: string): SkillProposal | null {
    const row = this.db
      .prepare(`SELECT * FROM skill_proposals WHERE profile = ? AND proposed_name = ?`)
      .get(profile, proposedName) as SkillProposalRow | null;
    return row ? rowToProposal(row) : null;
  }

  list(profile: string, opts: ListSkillProposalsOptions = {}): SkillProposal[] {
    const where = ['profile = ?'];
    const params: (string | number)[] = [profile];
    if (opts.status) {
      where.push('status = ?');
      params.push(opts.status);
    }
    const limitClause = typeof opts.limit === 'number' && opts.limit > 0 ? ` LIMIT ${Math.floor(opts.limit)}` : '';
    const rows = this.db
      .prepare(
        `SELECT * FROM skill_proposals
          WHERE ${where.join(' AND ')}
          ORDER BY created_at DESC${limitClause}`,
      )
      .all(...params) as SkillProposalRow[];
    return rows.map(rowToProposal);
  }

  /**
   * Approve a proposal. Caller must have already written the SKILL.md
   * artifact to the skill registry — this method only flips the
   * lifecycle and records the human decision. Trust tier stays at
   * `quarantined` until a separate `setTrustTier` call promotes it
   * (no auto-promotion: A6).
   */
  approve(id: string, profile: string, decidedBy: string, reason?: string): SkillProposal | null {
    const existing = this.get(id, profile);
    if (!existing) return null;
    if (existing.status === 'quarantined') {
      // Quarantined proposals cannot be one-click approved — the
      // operator must explicitly clear the safety flags first by
      // editing + re-creating the proposal. This is a hard rule (A6).
      return existing;
    }
    if (existing.status === 'approved') return existing;
    this.db
      .prepare(
        `UPDATE skill_proposals
            SET status = 'approved',
                decided_at = ?,
                decided_by = ?,
                decision_reason = ?
          WHERE id = ? AND profile = ?`,
      )
      .run(Date.now(), decidedBy, reason ?? null, id, profile);
    return this.get(id, profile);
  }

  reject(id: string, profile: string, decidedBy: string, reason: string): SkillProposal | null {
    const existing = this.get(id, profile);
    if (!existing) return null;
    if (existing.status === 'rejected') return existing;
    this.db
      .prepare(
        `UPDATE skill_proposals
            SET status = 'rejected',
                decided_at = ?,
                decided_by = ?,
                decision_reason = ?
          WHERE id = ? AND profile = ?`,
      )
      .run(Date.now(), decidedBy, reason, id, profile);
    return this.get(id, profile);
  }

  delete(id: string, profile: string): boolean {
    const res = this.db
      .prepare(`DELETE FROM skill_proposals WHERE id = ? AND profile = ?`)
      .run(id, profile);
    return res.changes > 0;
  }

  /**
   * Promote a proposal's trust tier. Lifecycle status (`pending` /
   * `approved` / etc.) is unaffected — a `quarantined` proposal can
   * be re-tiered to `community` once the operator has manually
   * sanitised the SKILL.md. Tier transitions are append-only via the
   * decided_by field on the eventual approve call (A8).
   */
  setTrustTier(
    id: string,
    profile: string,
    tier: SkillProposalTrust,
  ): SkillProposal | null {
    const existing = this.get(id, profile);
    if (!existing) return null;
    this.db
      .prepare(`UPDATE skill_proposals SET trust_tier = ? WHERE id = ? AND profile = ?`)
      .run(tier, id, profile);
    return this.get(id, profile);
  }
}

function rowToProposal(row: SkillProposalRow): SkillProposal {
  return {
    id: row.id,
    profile: row.profile,
    status: row.status as SkillProposalStatus,
    proposedName: row.proposed_name,
    proposedCategory: row.proposed_category,
    skillMd: row.skill_md,
    capabilityTags: safeParseJsonArray(row.capability_tags),
    toolsRequired: safeParseJsonArray(row.tools_required),
    sourceTaskIds: safeParseJsonArray(row.source_task_ids),
    evidenceEventIds: safeParseJsonArray(row.evidence_event_ids),
    successCount: row.success_count,
    safetyFlags: safeParseJsonArray(row.safety_flags),
    trustTier: row.trust_tier as SkillProposalTrust,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    decisionReason: row.decision_reason,
  };
}

function safeParseJsonArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function cryptoRandomId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  return g.crypto?.randomUUID?.() ?? `prop-${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}
