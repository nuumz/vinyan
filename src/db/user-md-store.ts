/**
 * UserMdStore — SQLite-backed store for the dialectic user-model (USER.md).
 *
 * Tables are created by migration 009 (`009_user_md_dialectic.ts`). This
 * store is the only component that talks to `user_md_sections` and
 * `user_md_prediction_errors`.
 *
 * Cross-profile reads are prohibited at this layer per w1-contracts §3:
 * every read takes `profile` explicitly. No `profile = 'ALL'` escape hatch
 * is exposed here.
 *
 * Axiom anchors:
 *   - A3 Deterministic governance — the store is a pure ledger; it does not
 *     decide revisions. `dialectic.applyDialectic` emits updates; the
 *     caller applies them via `applyRevision`.
 *   - A7 Prediction-error as learning — `recordError` ledgers every turn's
 *     delta so the rule has a replayable history.
 */
import type { Database } from 'bun:sqlite';

import type { ConfidenceTier } from '../core/confidence-tier.ts';
import type { UserMdSection } from '../orchestrator/user-context/user-md-schema.ts';

// ---------------------------------------------------------------------------
// Row shapes — columns are aliased in SELECTs so these stay camelCase.
// ---------------------------------------------------------------------------

interface SectionRow {
  slug: string;
  profile: string;
  heading: string;
  body: string;
  predictedResponse: string;
  evidenceTier: ConfidenceTier;
  confidence: number;
  lastRevisedAt: number | null;
}

interface ErrorRow {
  errorId: number;
  profile: string;
  slug: string;
  observed: string;
  predicted: string;
  delta: number;
  turnId: string | null;
  ts: number;
}

/** Public shape returned by `rollingWindow` and audit queries. */
export interface UserMdSectionError {
  readonly errorId: number;
  readonly profile: string;
  readonly slug: string;
  readonly observed: string;
  readonly predicted: string;
  readonly delta: number;
  readonly turnId?: string;
  readonly ts: number;
}

/** Input to `upsertSection` — a section plus its owning profile. */
export type UserMdSectionInput = UserMdSection & { profile: string };

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class UserMdStore {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /** Upsert a section (profile-scoped). Creates or replaces the whole row. */
  upsertSection(section: UserMdSectionInput): void {
    this.db.run(
      `INSERT INTO user_md_sections
         (slug, profile, heading, body, predicted_response, evidence_tier, confidence, last_revised_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile, slug) DO UPDATE SET
         heading = excluded.heading,
         body = excluded.body,
         predicted_response = excluded.predicted_response,
         evidence_tier = excluded.evidence_tier,
         confidence = excluded.confidence,
         last_revised_at = excluded.last_revised_at`,
      [
        section.slug,
        section.profile,
        section.heading,
        section.body,
        section.predictedResponse,
        section.evidenceTier,
        section.confidence,
        section.lastRevisedAt ?? null,
      ],
    );
  }

  /** Return every section for the profile, ordered by slug for stable diffs. */
  getSections(profile: string): UserMdSection[] {
    const rows = this.db
      .prepare(
        `SELECT slug,
                profile,
                heading,
                body,
                predicted_response AS predictedResponse,
                evidence_tier      AS evidenceTier,
                confidence,
                last_revised_at    AS lastRevisedAt
           FROM user_md_sections
          WHERE profile = ?
          ORDER BY slug ASC`,
      )
      .all(profile) as SectionRow[];
    return rows.map(rowToSection);
  }

  /** Look up a single section by (profile, slug). `undefined` if absent. */
  getSection(profile: string, slug: string): UserMdSection | undefined {
    const row = this.db
      .prepare(
        `SELECT slug,
                profile,
                heading,
                body,
                predicted_response AS predictedResponse,
                evidence_tier      AS evidenceTier,
                confidence,
                last_revised_at    AS lastRevisedAt
           FROM user_md_sections
          WHERE profile = ? AND slug = ?`,
      )
      .get(profile, slug) as SectionRow | null;
    return row ? rowToSection(row) : undefined;
  }

  /** Append a prediction-error observation for the given section. */
  recordError(args: {
    profile: string;
    slug: string;
    observed: string;
    predicted: string;
    delta: number;
    turnId?: string;
    ts: number;
  }): void {
    this.db.run(
      `INSERT INTO user_md_prediction_errors
         (profile, slug, observed, predicted, delta, turn_id, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [args.profile, args.slug, args.observed, args.predicted, args.delta, args.turnId ?? null, args.ts],
    );
  }

  /**
   * Return the most-recent `windowSize` prediction-error observations for
   * a section, oldest → newest (so callers can feed directly into
   * `dialectic.applyDialectic`). Never returns more than `windowSize` rows.
   */
  rollingWindow(profile: string, slug: string, windowSize: number): UserMdSectionError[] {
    if (windowSize <= 0) return [];
    const rows = this.db
      .prepare(
        `SELECT error_id AS errorId,
                profile,
                slug,
                observed,
                predicted,
                delta,
                turn_id   AS turnId,
                ts
           FROM user_md_prediction_errors
          WHERE profile = ? AND slug = ?
          ORDER BY ts DESC, error_id DESC
          LIMIT ?`,
      )
      .all(profile, slug, windowSize) as ErrorRow[];
    return rows.reverse().map(rowToError);
  }

  /**
   * Apply a dialectic decision to a section. Caller supplies only the fields
   * that changed; untouched fields are preserved. Always bumps `last_revised_at`.
   * Returns `true` if the row existed (and was updated), `false` otherwise.
   */
  applyRevision(
    profile: string,
    slug: string,
    update: {
      predictedResponse?: string;
      evidenceTier?: ConfidenceTier;
      confidence?: number;
      body?: string;
      lastRevisedAt: number;
    },
  ): boolean {
    const existing = this.getSection(profile, slug);
    if (!existing) return false;

    const merged: UserMdSectionInput = {
      ...existing,
      profile,
      predictedResponse: update.predictedResponse ?? existing.predictedResponse,
      evidenceTier: update.evidenceTier ?? existing.evidenceTier,
      confidence: update.confidence ?? existing.confidence,
      body: update.body ?? existing.body,
      lastRevisedAt: update.lastRevisedAt,
    };
    this.upsertSection(merged);
    return true;
  }

  /** Danger: full wipe for a profile. Used by reset helpers and tests. */
  deleteProfile(profile: string): void {
    this.db.run('DELETE FROM user_md_sections WHERE profile = ?', [profile]);
    this.db.run('DELETE FROM user_md_prediction_errors WHERE profile = ?', [profile]);
  }
}

// ---------------------------------------------------------------------------
// Row → domain mappers
// ---------------------------------------------------------------------------

function rowToSection(row: SectionRow): UserMdSection {
  const section: UserMdSection = {
    slug: row.slug,
    heading: row.heading,
    body: row.body,
    predictedResponse: row.predictedResponse,
    evidenceTier: row.evidenceTier,
    confidence: row.confidence,
  };
  if (row.lastRevisedAt !== null) {
    section.lastRevisedAt = row.lastRevisedAt;
  }
  return section;
}

function rowToError(row: ErrorRow): UserMdSectionError {
  const out: UserMdSectionError = {
    errorId: row.errorId,
    profile: row.profile,
    slug: row.slug,
    observed: row.observed,
    predicted: row.predicted,
    delta: row.delta,
    ts: row.ts,
  };
  if (row.turnId !== null) {
    (out as { turnId?: string }).turnId = row.turnId;
  }
  return out;
}
