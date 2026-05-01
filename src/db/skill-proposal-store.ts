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

/**
 * Correlated subquery returning the latest revision number for a
 * proposal. Inlined into every SELECT so the entity carries
 * `latestRevision` without an extra round-trip — the editor uses it
 * as the optimistic-lock baseline (G2-extension), so it must be
 * present on the proposal entity itself, not on a separate revisions
 * query that loads asynchronously.
 */
const LATEST_REVISION_SUBQUERY = `(
  SELECT COALESCE(MAX(r.revision), 1)
  FROM skill_proposal_revisions r
  WHERE r.profile = skill_proposals.profile AND r.proposal_id = skill_proposals.id
) AS latest_revision`;

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
  /**
   * Latest revision number for this proposal (G2-extension).
   *
   * Computed via correlated subquery on every read. The editor uses
   * this value as the `expectedRevision` baseline for optimistic
   * locking — having it on the proposal entity itself avoids the
   * race window where a separate `useSkillProposalRevisions` query
   * is still loading and the operator could submit a PATCH without
   * the optimistic-lock token.
   */
  readonly latestRevision: number;
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
  /** Computed via correlated subquery — `MAX(revision)` from `skill_proposal_revisions`. */
  latest_revision: number;
}

export interface SkillProposalRevision {
  readonly id: number;
  readonly profile: string;
  readonly proposalId: string;
  readonly revision: number;
  readonly skillMd: string;
  readonly safetyFlags: ReadonlyArray<string>;
  readonly actor: string;
  readonly reason: string | null;
  readonly createdAt: number;
}

/** G6: cap on retained revisions per proposal (prevent edit-spam table bloat). */
export const MAX_REVISIONS_PER_PROPOSAL = 100;
/** G1: reject draft / scan payloads larger than this — regex-DOS guard. */
export const MAX_SKILL_MD_BYTES = 100 * 1024;

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
    // Seed revision 1 — the initial create. Lets the UI render a
    // complete history without a special-case "before any edits" row.
    this.db
      .prepare(
        `INSERT INTO skill_proposal_revisions
           (profile, proposal_id, revision, skill_md, safety_flags_json,
            actor, reason, created_at)
         VALUES (?, ?, 1, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.profile,
        id,
        input.skillMd,
        JSON.stringify(verdict.flags),
        'auto-generator',
        'initial create',
        now,
      );
    const row = this.get(id, input.profile);
    if (!row) throw new Error('SkillProposalStore: insert failed to round-trip');
    return row;
  }

  /**
   * Update the SKILL.md draft for an existing proposal. R2: lets the
   * operator edit a quarantined proposal and re-scan in place rather
   * than having to POST a fresh proposal.
   *
   * Lifecycle / behaviour:
   *   - returns `{ kind: 'not-found' }` when the row does not exist.
   *   - decided proposals (approved / rejected) → `{ kind: 'immutable' }`.
   *   - **G2 optimistic locking**: when `expectedRevision` is supplied,
   *     compare against the current latest revision. Mismatch →
   *     `{ kind: 'precondition-failed', latestRevision }`. Two
   *     operators editing the same draft can't silently overwrite
   *     each other's work; the second writer is told to refresh.
   *   - safety scanner runs on the new bytes. If flags fire, status
   *     flips to `quarantined`; if flags clear AND the prior status
   *     was `quarantined`, status flips back to `pending`.
   *   - a revision row is appended atomically with the update, so the
   *     audit trail exists even if the post-update read fails.
   *   - `actor` is required so every revision names a human (A8).
   *   - **G6 revision cap**: at most `MAX_REVISIONS_PER_PROPOSAL` rows
   *     are retained per proposal. When exceeded, oldest rows beyond
   *     the most-recent N (excluding revision 1, which is preserved
   *     as provenance) are dropped inside the same transaction.
   */
  updateDraft(args: {
    id: string;
    profile: string;
    skillMd: string;
    actor: string;
    reason?: string;
    /** G2 optimistic-locking expectation. */
    expectedRevision?: number;
  }):
    | { kind: 'ok'; proposal: SkillProposal; revision: number }
    | { kind: 'not-found' }
    | { kind: 'immutable'; status: SkillProposalStatus }
    | { kind: 'precondition-failed'; latestRevision: number } {
    const existing = this.get(args.id, args.profile);
    if (!existing) return { kind: 'not-found' };
    if (existing.status === 'approved' || existing.status === 'rejected') {
      return { kind: 'immutable', status: existing.status };
    }
    const verdict = memorySafetyVerdict(args.skillMd);
    const nextStatus: SkillProposalStatus = verdict.safe
      ? existing.status === 'quarantined'
        ? 'pending'
        : existing.status
      : 'quarantined';
    const now = Date.now();
    const tx = this.db.transaction(() => {
      const latest = (this.db
        .prepare(
          `SELECT COALESCE(MAX(revision), 0) AS n FROM skill_proposal_revisions
            WHERE profile = ? AND proposal_id = ?`,
        )
        .get(args.profile, args.id) as { n: number }).n;
      // G2: short-circuit on stale expectation. The frontend hands
      // back the revision it was viewing when the operator started
      // editing. A mismatch means another writer landed in between.
      if (typeof args.expectedRevision === 'number' && args.expectedRevision !== latest) {
        return { kind: 'precondition-failed' as const, latestRevision: latest };
      }
      this.db
        .prepare(
          `UPDATE skill_proposals
              SET skill_md = ?,
                  safety_flags = ?,
                  status = ?
            WHERE id = ? AND profile = ?`,
        )
        .run(
          args.skillMd,
          JSON.stringify(verdict.flags),
          nextStatus,
          args.id,
          args.profile,
        );
      const nextRevision = latest + 1;
      this.db
        .prepare(
          `INSERT INTO skill_proposal_revisions
             (profile, proposal_id, revision, skill_md, safety_flags_json,
              actor, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          args.profile,
          args.id,
          nextRevision,
          args.skillMd,
          JSON.stringify(verdict.flags),
          args.actor,
          args.reason ?? null,
          now,
        );
      // G6: trim history if we exceeded the per-proposal cap. Always
      // keep revision 1 (initial create) plus the most-recent
      // (cap - 1) rows. Mid-history rows are the cheapest to evict.
      this.db
        .prepare(
          `DELETE FROM skill_proposal_revisions
            WHERE profile = ?
              AND proposal_id = ?
              AND revision <> 1
              AND revision NOT IN (
                SELECT revision FROM skill_proposal_revisions
                 WHERE profile = ? AND proposal_id = ?
                 ORDER BY revision DESC
                 LIMIT ?
              )`,
        )
        .run(
          args.profile,
          args.id,
          args.profile,
          args.id,
          MAX_REVISIONS_PER_PROPOSAL - 1,
        );
      return { kind: 'ok' as const, revision: nextRevision };
    });
    const result = tx() as
      | { kind: 'ok'; revision: number }
      | { kind: 'precondition-failed'; latestRevision: number };
    if (result.kind === 'precondition-failed') {
      return result;
    }
    const after = this.get(args.id, args.profile);
    if (!after) return { kind: 'not-found' };
    return { kind: 'ok', proposal: after, revision: result.revision };
  }

  /** List the most-recent revisions for a proposal, newest first. */
  listRevisions(profile: string, proposalId: string, limit = 50): SkillProposalRevision[] {
    const rows = this.db
      .prepare(
        `SELECT id, profile, proposal_id, revision, skill_md,
                safety_flags_json, actor, reason, created_at
           FROM skill_proposal_revisions
          WHERE profile = ? AND proposal_id = ?
          ORDER BY revision DESC
          LIMIT ?`,
      )
      .all(profile, proposalId, limit) as Array<{
      id: number;
      profile: string;
      proposal_id: string;
      revision: number;
      skill_md: string;
      safety_flags_json: string;
      actor: string;
      reason: string | null;
      created_at: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      profile: r.profile,
      proposalId: r.proposal_id,
      revision: r.revision,
      skillMd: r.skill_md,
      safetyFlags: safeParseJsonArray(r.safety_flags_json),
      actor: r.actor,
      reason: r.reason,
      createdAt: r.created_at,
    }));
  }

  get(id: string, profile: string): SkillProposal | null {
    const row = this.db
      .prepare(
        `SELECT skill_proposals.*, ${LATEST_REVISION_SUBQUERY}
           FROM skill_proposals
          WHERE id = ? AND profile = ?`,
      )
      .get(id, profile) as SkillProposalRow | null;
    return row ? rowToProposal(row) : null;
  }

  findByName(profile: string, proposedName: string): SkillProposal | null {
    const row = this.db
      .prepare(
        `SELECT skill_proposals.*, ${LATEST_REVISION_SUBQUERY}
           FROM skill_proposals
          WHERE profile = ? AND proposed_name = ?`,
      )
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
        `SELECT skill_proposals.*, ${LATEST_REVISION_SUBQUERY}
           FROM skill_proposals
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
    // Defensive — defaults to 1 (the always-present create row) when
    // the correlated subquery produced NULL (no revision rows yet,
    // which is impossible after mig 032 + create() but the subquery
    // uses COALESCE for safety).
    latestRevision: typeof row.latest_revision === 'number' && row.latest_revision > 0
      ? row.latest_revision
      : 1,
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
