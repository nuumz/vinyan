/**
 * `PersonaOverclaimStore` — Phase-14 SQLite-backed ledger for the
 * persona-keyed overclaim tracker (Phase 12).
 *
 * Mirrors the `SkillOutcomeStore` pattern: INSERT OR ON CONFLICT update,
 * parameterised clock for tests, primary-key uniqueness on `persona_id`.
 *
 * Bounded write rate: at most one `recordOverclaim` and one `recordObservation`
 * per executeTask completion that crossed `OVERCLAIM_MIN_LOADED_SKILLS`. Per-
 * record writes are well within SQLite's tolerance — no batching required.
 */
import type { Database } from 'bun:sqlite';

export interface PersonaOverclaimRecord {
  personaId: string;
  observations: number;
  overclaims: number;
  lastUpdated: number;
}

interface PersonaOverclaimRow {
  persona_id: string;
  observations: number;
  overclaims: number;
  last_updated: number;
}

export class PersonaOverclaimStore {
  constructor(private readonly db: Database) {}

  /** Increment the observations counter for a persona. Idempotent on PK. */
  recordObservation(personaId: string, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO persona_overclaim (persona_id, observations, overclaims, last_updated)
         VALUES (?, 1, 0, ?)
         ON CONFLICT(persona_id) DO UPDATE SET
           observations = observations + 1,
           last_updated = excluded.last_updated`,
      )
      .run(personaId, now);
  }

  /** Increment the overclaims counter for a persona. Idempotent on PK. */
  recordOverclaim(personaId: string, now = Date.now()): void {
    this.db
      .prepare(
        `INSERT INTO persona_overclaim (persona_id, observations, overclaims, last_updated)
         VALUES (?, 0, 1, ?)
         ON CONFLICT(persona_id) DO UPDATE SET
           overclaims = overclaims + 1,
           last_updated = excluded.last_updated`,
      )
      .run(personaId, now);
  }

  /** Read one persona's record. Returns null when no observations or overclaims have been recorded. */
  getRecord(personaId: string): PersonaOverclaimRecord | null {
    const row = this.db
      .prepare(
        `SELECT persona_id, observations, overclaims, last_updated
         FROM persona_overclaim WHERE persona_id = ?`,
      )
      .get(personaId) as PersonaOverclaimRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  /**
   * Snapshot every persona's record. Used by the tracker on startup to
   * rehydrate its in-memory map from disk so penalty math survives a
   * restart.
   */
  listAll(): PersonaOverclaimRecord[] {
    const rows = this.db
      .prepare(
        `SELECT persona_id, observations, overclaims, last_updated
         FROM persona_overclaim ORDER BY persona_id ASC`,
      )
      .all() as PersonaOverclaimRow[];
    return rows.map(rowToRecord);
  }
}

function rowToRecord(row: PersonaOverclaimRow): PersonaOverclaimRecord {
  return {
    personaId: row.persona_id,
    observations: row.observations,
    overclaims: row.overclaims,
    lastUpdated: row.last_updated,
  };
}
