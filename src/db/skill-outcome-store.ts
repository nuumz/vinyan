/**
 * `SkillOutcomeStore` — Phase-3 per-(persona, skill, task-signature) outcome tracking.
 *
 * Distinct from `BidAccuracyTracker` (provider-keyed cost-prediction accuracy)
 * and `ProviderTrustStore` (provider × capability success rates):
 *
 *   - SkillOutcomeStore answers "did this *skill* help this *persona* on
 *     this *task family*?" — the signal that drives Phase-4 autonomous skill
 *     creation triggers and, eventually, skill-tier graduation
 *     (probationary → heuristic → deterministic).
 *
 *   - BidAccuracyTracker answers "did this *provider* estimate accurately?".
 *     Orthogonal — a provider can be accurate for any persona.
 *
 *   - ProviderTrustStore answers "does this *provider* succeed at this
 *     *capability*?". Pre-Phase-3 trust pool; remains the auction-time signal
 *     for `trust²` term in scoreBid.
 *
 * Wilson LB query is bounded by `WILSON_FLOOR_MIN_TRIALS` from
 * `capability-trust.ts` so cold-start (n<10) returns the neutral 0.5 — A2
 * uncertainty surfaced explicitly rather than faked into a confident number.
 */
import type { Database } from 'bun:sqlite';
import { WILSON_COLD_START, WILSON_FLOOR_MIN_TRIALS } from '../orchestrator/capability-trust.ts';
import { wilsonLowerBound } from '../sleep-cycle/wilson.ts';

export interface SkillOutcomeKey {
  personaId: string;
  skillId: string;
  taskSignature: string;
}

export interface SkillOutcomeRecord extends SkillOutcomeKey {
  successes: number;
  failures: number;
  lastOutcomeAt: number;
}

export type SkillOutcome = 'success' | 'failure';

interface SkillOutcomeRow {
  persona_id: string;
  skill_id: string;
  task_signature: string;
  successes: number;
  failures: number;
  last_outcome_at: number;
}

export class SkillOutcomeStore {
  constructor(private readonly db: Database) {}

  /**
   * Record one task outcome for a (persona, skill, taskSig) tuple. Idempotent
   * on key — increments the appropriate counter and updates last_outcome_at.
   * `now` is parameterised so tests can pin a deterministic clock.
   */
  recordOutcome(key: SkillOutcomeKey, outcome: SkillOutcome, now = Date.now()): void {
    const successDelta = outcome === 'success' ? 1 : 0;
    const failureDelta = outcome === 'failure' ? 1 : 0;
    this.db
      .prepare(
        `INSERT INTO skill_outcomes (persona_id, skill_id, task_signature, successes, failures, last_outcome_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(persona_id, skill_id, task_signature) DO UPDATE SET
           successes = successes + excluded.successes,
           failures = failures + excluded.failures,
           last_outcome_at = excluded.last_outcome_at`,
      )
      .run(key.personaId, key.skillId, key.taskSignature, successDelta, failureDelta, now);
  }

  /** Read the row for a single tuple. Returns null when no outcomes are recorded. */
  getOutcome(key: SkillOutcomeKey): SkillOutcomeRecord | null {
    const row = this.db
      .prepare(
        `SELECT persona_id, skill_id, task_signature, successes, failures, last_outcome_at
         FROM skill_outcomes
         WHERE persona_id = ? AND skill_id = ? AND task_signature = ?`,
      )
      .get(key.personaId, key.skillId, key.taskSignature) as SkillOutcomeRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  /** Scan all outcome rows for a persona. Used by sleep-cycle promotion paths. */
  listForPersona(personaId: string): SkillOutcomeRecord[] {
    const rows = this.db
      .prepare(
        `SELECT persona_id, skill_id, task_signature, successes, failures, last_outcome_at
         FROM skill_outcomes WHERE persona_id = ? ORDER BY last_outcome_at DESC`,
      )
      .all(personaId) as SkillOutcomeRow[];
    return rows.map(rowToRecord);
  }

  /** Scan all outcome rows for a skill across personas / task signatures. */
  listForSkill(skillId: string): SkillOutcomeRecord[] {
    const rows = this.db
      .prepare(
        `SELECT persona_id, skill_id, task_signature, successes, failures, last_outcome_at
         FROM skill_outcomes WHERE skill_id = ? ORDER BY last_outcome_at DESC`,
      )
      .all(skillId) as SkillOutcomeRow[];
    return rows.map(rowToRecord);
  }

  /**
   * Wilson LB on the success rate for a (persona, skill, taskSig) tuple. When
   * fewer than `WILSON_FLOOR_MIN_TRIALS` outcomes are recorded the call returns
   * `WILSON_COLD_START` (0.5) so a single-trial success can't be mistaken for
   * established performance — A2 First-Class Uncertainty.
   */
  wilsonLowerBound(key: SkillOutcomeKey): number {
    const record = this.getOutcome(key);
    if (!record) return WILSON_COLD_START;
    const total = record.successes + record.failures;
    if (total < WILSON_FLOOR_MIN_TRIALS) return WILSON_COLD_START;
    return wilsonLowerBound(record.successes, total);
  }
}

function rowToRecord(row: SkillOutcomeRow): SkillOutcomeRecord {
  return {
    personaId: row.persona_id,
    skillId: row.skill_id,
    taskSignature: row.task_signature,
    successes: row.successes,
    failures: row.failures,
    lastOutcomeAt: row.last_outcome_at,
  };
}

/**
 * Fan one task outcome out to every loaded skill on a persona-aware bid.
 *
 * Phase-3 schema enables per-(persona, skill, taskSig) attribution; Phase-4
 * autonomous skill creator will read this signal to trigger drafts. The
 * helper exists at the db layer so settlement / phase-learn callers can wire
 * it without re-deriving the loadout themselves — they pass the bid (which
 * already carries `personaId` + `loadedSkillIds`), the task signature, and
 * the outcome.
 *
 * No-op when `personaId` is absent or `loadedSkillIds` is empty. This makes
 * the helper safe to call unconditionally — legacy non-persona bids do not
 * record anything, no errors emitted.
 *
 * Equal credit: every loaded skill receives the same outcome counter. A more
 * accurate per-skill attribution scheme (only credit skills whose `whenToUse`
 * fingerprint matched the task) is a Phase-4 refinement — risk M2.
 */
export interface PersonaBidLike {
  personaId?: string;
  loadedSkillIds?: readonly string[];
}

export function recordSkillOutcomesFromBid(
  store: SkillOutcomeStore,
  bid: PersonaBidLike,
  taskSignature: string,
  outcome: SkillOutcome,
  now = Date.now(),
): number {
  const personaId = bid.personaId;
  const skills = bid.loadedSkillIds ?? [];
  if (!personaId || skills.length === 0) return 0;
  for (const skillId of skills) {
    store.recordOutcome({ personaId, skillId, taskSignature }, outcome, now);
  }
  return skills.length;
}
