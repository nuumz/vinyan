/**
 * VolunteerStore — SQLite persistence for volunteer offers + helpfulness
 * counter. Schema from migration 034.
 *
 * The helpfulness counter is the ONLY cross-task signal the volunteer
 * protocol exposes. It is intentionally kept out of bid scoring
 * (docs/design/vinyan-os-ecosystem-plan.md §3.3) — it feeds promotion
 * gates only, so indiscriminate volunteering does not translate into
 * auction advantage.
 */

import type { Database, Statement } from 'bun:sqlite';

export interface VolunteerOfferRecord {
  readonly offerId: string;
  readonly taskId: string;
  readonly engineId: string;
  readonly offeredAt: number;
  readonly acceptedAt: number | null;
  readonly commitmentId: string | null;
  readonly declinedReason: string | null;
}

export interface HelpfulnessRecord {
  readonly engineId: string;
  readonly offersMade: number;
  readonly offersAccepted: number;
  readonly deliveriesCompleted: number;
  readonly lastUpdatedAt: number;
}

interface OfferRow {
  offer_id: string;
  task_id: string;
  engine_id: string;
  offered_at: number;
  accepted_at: number | null;
  commitment_id: string | null;
  declined_reason: string | null;
}

interface HelpfulnessRow {
  engine_id: string;
  offers_made: number;
  offers_accepted: number;
  deliveries_completed: number;
  last_updated_at: number;
}

export class VolunteerStore {
  private readonly sInsertOffer: Statement;
  private readonly sGetOffer: Statement;
  private readonly sListOffersByTask: Statement;
  private readonly sAcceptOffer: Statement;
  private readonly sDeclineOffer: Statement;
  private readonly sGetOfferByCommitment: Statement;

  private readonly sBumpOfferCount: Statement;
  private readonly sBumpAcceptCount: Statement;
  private readonly sBumpDeliveryCount: Statement;
  private readonly sGetHelpfulness: Statement;
  private readonly sListHelpfulness: Statement;

  constructor(db: Database) {
    this.sInsertOffer = db.prepare(`
      INSERT INTO volunteer_offers (offer_id, task_id, engine_id, offered_at)
      VALUES (?, ?, ?, ?)
    `);
    this.sGetOffer = db.prepare('SELECT * FROM volunteer_offers WHERE offer_id = ?');
    this.sListOffersByTask = db.prepare(
      `SELECT * FROM volunteer_offers
          WHERE task_id = ?
          ORDER BY offered_at`,
    );
    this.sAcceptOffer = db.prepare(
      `UPDATE volunteer_offers
          SET accepted_at = ?, commitment_id = ?
        WHERE offer_id = ? AND accepted_at IS NULL AND declined_reason IS NULL`,
    );
    this.sDeclineOffer = db.prepare(
      `UPDATE volunteer_offers
          SET declined_reason = ?
        WHERE offer_id = ? AND accepted_at IS NULL AND declined_reason IS NULL`,
    );
    this.sGetOfferByCommitment = db.prepare(
      'SELECT * FROM volunteer_offers WHERE commitment_id = ?',
    );

    const upsert = db.prepare(`
      INSERT INTO engine_helpfulness (engine_id, offers_made, offers_accepted, deliveries_completed, last_updated_at)
      VALUES (?, 0, 0, 0, ?)
      ON CONFLICT(engine_id) DO NOTHING
    `);
    this.sBumpOfferCount = db.prepare(
      `UPDATE engine_helpfulness
          SET offers_made = offers_made + 1, last_updated_at = ?
        WHERE engine_id = ?`,
    );
    this.sBumpAcceptCount = db.prepare(
      `UPDATE engine_helpfulness
          SET offers_accepted = offers_accepted + 1, last_updated_at = ?
        WHERE engine_id = ?`,
    );
    this.sBumpDeliveryCount = db.prepare(
      `UPDATE engine_helpfulness
          SET deliveries_completed = deliveries_completed + 1, last_updated_at = ?
        WHERE engine_id = ?`,
    );
    this.sGetHelpfulness = db.prepare('SELECT * FROM engine_helpfulness WHERE engine_id = ?');
    this.sListHelpfulness = db.prepare(
      'SELECT * FROM engine_helpfulness ORDER BY deliveries_completed DESC, offers_made DESC',
    );

    // Expose upsert via private helper used before bumps
    this.ensureHelpfulnessRow = (engineId: string, at: number) => {
      upsert.run(engineId, at);
    };
  }

  private readonly ensureHelpfulnessRow: (engineId: string, at: number) => void;

  // ── Offers ───────────────────────────────────────────────────────

  insertOffer(offer: {
    offerId: string;
    taskId: string;
    engineId: string;
    offeredAt: number;
  }): void {
    this.sInsertOffer.run(offer.offerId, offer.taskId, offer.engineId, offer.offeredAt);
    this.ensureHelpfulnessRow(offer.engineId, offer.offeredAt);
    this.sBumpOfferCount.run(offer.offeredAt, offer.engineId);
  }

  getOffer(offerId: string): VolunteerOfferRecord | null {
    const row = this.sGetOffer.get(offerId) as OfferRow | null;
    return row ? mapOffer(row) : null;
  }

  listOffersByTask(taskId: string): readonly VolunteerOfferRecord[] {
    return (this.sListOffersByTask.all(taskId) as OfferRow[]).map(mapOffer);
  }

  acceptOffer(params: { offerId: string; commitmentId: string; at: number }): boolean {
    const r = this.sAcceptOffer.run(
      params.at,
      params.commitmentId,
      params.offerId,
    ) as { changes: number };
    if (r.changes > 0) {
      const offer = this.getOffer(params.offerId);
      if (offer) {
        this.ensureHelpfulnessRow(offer.engineId, params.at);
        this.sBumpAcceptCount.run(params.at, offer.engineId);
      }
    }
    return r.changes > 0;
  }

  declineOffer(offerId: string, reason: string): boolean {
    const r = this.sDeclineOffer.run(reason, offerId) as { changes: number };
    return r.changes > 0;
  }

  findOfferByCommitment(commitmentId: string): VolunteerOfferRecord | null {
    const row = this.sGetOfferByCommitment.get(commitmentId) as OfferRow | null;
    return row ? mapOffer(row) : null;
  }

  // ── Helpfulness ──────────────────────────────────────────────────

  recordDelivery(engineId: string, at: number): void {
    this.ensureHelpfulnessRow(engineId, at);
    this.sBumpDeliveryCount.run(at, engineId);
  }

  getHelpfulness(engineId: string): HelpfulnessRecord | null {
    const row = this.sGetHelpfulness.get(engineId) as HelpfulnessRow | null;
    return row ? mapHelpfulness(row) : null;
  }

  listHelpfulness(): readonly HelpfulnessRecord[] {
    return (this.sListHelpfulness.all() as HelpfulnessRow[]).map(mapHelpfulness);
  }
}

function mapOffer(row: OfferRow): VolunteerOfferRecord {
  return {
    offerId: row.offer_id,
    taskId: row.task_id,
    engineId: row.engine_id,
    offeredAt: row.offered_at,
    acceptedAt: row.accepted_at,
    commitmentId: row.commitment_id,
    declinedReason: row.declined_reason,
  };
}

function mapHelpfulness(row: HelpfulnessRow): HelpfulnessRecord {
  return {
    engineId: row.engine_id,
    offersMade: row.offers_made,
    offersAccepted: row.offers_accepted,
    deliveriesCompleted: row.deliveries_completed,
    lastUpdatedAt: row.last_updated_at,
  };
}
