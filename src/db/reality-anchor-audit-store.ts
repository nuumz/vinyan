/**
 * `RealityAnchorAuditStore` — Phase C4 substrate.
 *
 * Append-only ledger of reality-anchor state transitions + sub-action
 * stages. The regrounder writes one row per audit event; current
 * persona state is derived from the latest row per persona.
 *
 * Bounded write rate: one row per workflow stage per persona per
 * recovery cycle. A complete recovery (active → quarantined → rebuilding
 * → shadow-mode → active) writes 5 audit rows total. Even at 100
 * triggers/day, the table grows by ≤500 rows/day.
 *
 * Same shape and conventions as PersonaFactCitationsStore — append-only,
 * idempotent on composite PK, parameterised clock for tests.
 */
import type { Database } from 'bun:sqlite';
import type { RealityAnchorStage, RealityAnchorState } from '../orchestrator/agents/reality-anchor/state.ts';

export interface RealityAnchorAuditRecord {
  personaId: string;
  prevState: RealityAnchorState;
  newState: RealityAnchorState;
  stage: RealityAnchorStage;
  reason: string;
  recordedAt: number;
}

interface RealityAnchorAuditRow {
  persona_id: string;
  prev_state: string;
  new_state: string;
  stage: string;
  reason: string;
  recorded_at: number;
}

export interface RecordAuditInput {
  readonly personaId: string;
  readonly prevState: RealityAnchorState;
  readonly newState: RealityAnchorState;
  readonly stage: RealityAnchorStage;
  readonly reason: string;
  readonly recordedAt?: number;
}

export class RealityAnchorAuditStore {
  constructor(private readonly db: Database) {}

  /**
   * Append an audit row. Idempotent on (persona_id, recorded_at) —
   * duplicate writes within a single millisecond are silently dropped
   * via INSERT OR IGNORE. Real callers separate sequential audit writes
   * by at least 1ms via the regrounder's clock; this guard catches
   * accidental same-ms collisions in tests / concurrent runs.
   */
  recordAudit(input: RecordAuditInput): void {
    const ts = input.recordedAt ?? Date.now();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO reality_anchor_audit
           (persona_id, prev_state, new_state, stage, reason, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.personaId, input.prevState, input.newState, input.stage, input.reason, ts);
  }

  /**
   * Latest audit row per persona. The regrounder uses this on boot to
   * hydrate its in-memory state cache so persona states survive
   * restarts.
   */
  getLatestStateMap(): Map<string, RealityAnchorState> {
    // SQLite GROUP BY with MAX(recorded_at) — one row per persona, the latest.
    const rows = this.db
      .prepare(
        `SELECT persona_id, new_state, MAX(recorded_at) AS recorded_at
           FROM reality_anchor_audit
          GROUP BY persona_id`,
      )
      .all() as { persona_id: string; new_state: string; recorded_at: number }[];
    const out = new Map<string, RealityAnchorState>();
    for (const row of rows) {
      out.set(row.persona_id, row.new_state as RealityAnchorState);
    }
    return out;
  }

  /** Audit history for a single persona, newest-first. Used for trace replay + operator dashboards. */
  listForPersona(personaId: string, limit = 1000): RealityAnchorAuditRecord[] {
    const rows = this.db
      .prepare(
        `SELECT persona_id, prev_state, new_state, stage, reason, recorded_at
           FROM reality_anchor_audit
          WHERE persona_id = ?
          ORDER BY recorded_at DESC
          LIMIT ?`,
      )
      .all(personaId, limit) as RealityAnchorAuditRow[];
    return rows.map(rowToRecord);
  }

  /** Recent audits across all personas, newest-first. Used by sleep-cycle health checks. */
  listRecent(limit = 100): RealityAnchorAuditRecord[] {
    const rows = this.db
      .prepare(
        `SELECT persona_id, prev_state, new_state, stage, reason, recorded_at
           FROM reality_anchor_audit
          ORDER BY recorded_at DESC
          LIMIT ?`,
      )
      .all(limit) as RealityAnchorAuditRow[];
    return rows.map(rowToRecord);
  }

  /** Count of audit rows by stage for a persona. Cheap summary for ops dashboards. */
  countByStageForPersona(personaId: string): Record<RealityAnchorStage, number> {
    const rows = this.db
      .prepare(
        `SELECT stage, COUNT(*) AS n
           FROM reality_anchor_audit
          WHERE persona_id = ?
          GROUP BY stage`,
      )
      .all(personaId) as { stage: string; n: number }[];
    const out: Record<RealityAnchorStage, number> = {
      quarantine: 0,
      rebuild: 0,
      prune: 0,
      replay: 0,
      reentry: 0,
    };
    for (const row of rows) {
      if (row.stage in out) {
        out[row.stage as RealityAnchorStage] = row.n;
      }
    }
    return out;
  }
}

function rowToRecord(row: RealityAnchorAuditRow): RealityAnchorAuditRecord {
  return {
    personaId: row.persona_id,
    prevState: row.prev_state as RealityAnchorState,
    newState: row.new_state as RealityAnchorState,
    stage: row.stage as RealityAnchorStage,
    reason: row.reason,
    recordedAt: row.recorded_at,
  };
}
