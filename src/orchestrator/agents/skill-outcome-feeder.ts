/**
 * SkillOutcomeFeeder — Phase-9 bridge between Phase-3 SkillOutcomeStore and
 * Phase-8 persona-keyed AutonomousSkillCreator windows.
 *
 * The autonomous creator wants `PredictionErrorSample` events. Phase-3
 * captures task outcomes per (persona, skill, taskSig) but in a different
 * shape — success/failure counts, not prediction-error samples. This module
 * is the translator.
 *
 * Sample mapping:
 *   - `success` outcome → `compositeError = LOW_ERROR`, outcome `'success'`
 *   - `failure` outcome → `compositeError = HIGH_ERROR`, outcome `'failure'`
 *
 * Why constant errors? Phase-3 only records binary success/failure. The
 * creator's window machinery uses `compositeError` to detect "error
 * reduction trend" — but with binary signals the trend collapses to
 * "success rate". The creator's split-half test still works on the
 * resulting samples because it averages composite errors over each half;
 * a half with more successes has a lower mean error.
 *
 * Design notes:
 *   - **A3**: pure data transform; no LLM
 *   - **A8**: each sample carries `taskId` derived deterministically from
 *     (personaId, skillId, taskSig, lastOutcomeAt) so feeding the same
 *     store twice produces identical sample sequences
 *   - **A9**: never throws — errors during iteration are swallowed and the
 *     count is reported back to the caller
 *
 * Phase-9 ships only the feeder. The sleep-cycle invocation of `tryDraftFor`
 * is deferred to Phase-10 (autonomous creation full wiring).
 */

import type { SkillOutcomeRecord, SkillOutcomeStore } from '../../db/skill-outcome-store.ts';
import type { AutonomousSkillCreator } from '../../skills/autonomous/creator.ts';
import type { PredictionErrorSample } from '../../skills/autonomous/types.ts';
import type { AgentRegistry } from './registry.ts';

/**
 * Composite-error values used when translating binary success/failure into
 * the creator's continuous-error shape. Picked symmetrically around 0.5 so
 * the split-half test detects trends in either direction:
 *   - LOW_ERROR (0.2) on success
 *   - HIGH_ERROR (0.8) on failure
 *
 * Both are bounded inside [0, 1] — the creator's window math validates that.
 */
export const SUCCESS_COMPOSITE_ERROR = 0.2;
export const FAILURE_COMPOSITE_ERROR = 0.8;

export interface FeedResult {
  /** Number of samples that were fed into the creator. */
  samplesEmitted: number;
  /** Outcome rows iterated. >= samplesEmitted (some rows may produce 0 samples). */
  rowsScanned: number;
}

/**
 * Walk the SkillOutcomeStore and feed every (persona, skill, taskSig) row
 * as one or more `PredictionErrorSample`s into the creator. The creator's
 * persona-keyed windows accumulate the samples for future `tryDraftFor`
 * invocations.
 *
 * Per-row sample expansion: a row recording `successes=5, failures=2` over
 * the same (persona, skill, taskSig) tuple produces 7 samples — 5 success
 * samples followed by 2 failure samples. Timestamps interpolate around
 * `lastOutcomeAt` so split-half ordering is deterministic.
 *
 * Returns summary counts; never throws.
 */
export function feedSkillOutcomesToCreator(
  creator: Pick<AutonomousSkillCreator, 'observe'>,
  store: Pick<SkillOutcomeStore, 'listForPersona'>,
  registry: Pick<AgentRegistry, 'listAgents'>,
): FeedResult {
  let samplesEmitted = 0;
  let rowsScanned = 0;

  try {
    for (const persona of registry.listAgents()) {
      let rows: SkillOutcomeRecord[];
      try {
        rows = store.listForPersona(persona.id);
      } catch {
        continue; // A9: never throw on store IO
      }
      for (const row of rows) {
        rowsScanned++;
        const samples = expandRowToSamples(row);
        for (const sample of samples) {
          try {
            creator.observe(sample);
            samplesEmitted++;
          } catch {
            /* A9: creator.observe should never throw, but guard regardless */
          }
        }
      }
    }
  } catch {
    /* A9: registry.listAgents() should never throw, but guard regardless */
  }

  return { samplesEmitted, rowsScanned };
}

/**
 * Expand one SkillOutcomeRecord into the corresponding PredictionErrorSample
 * sequence — `successes` 'success' samples followed by `failures` 'failure'
 * samples. Timestamps are interpolated within ±N ms of `lastOutcomeAt` so
 * the order is deterministic and stable across re-feeds.
 */
export function expandRowToSamples(row: SkillOutcomeRecord): PredictionErrorSample[] {
  const total = row.successes + row.failures;
  if (total === 0) return [];

  // Spread sample timestamps deterministically around lastOutcomeAt so
  // split-half partitioning behaves predictably. Successes come first
  // (older timestamps) then failures — chronological order is arbitrary
  // here since the store doesn't preserve per-event timing.
  const samples: PredictionErrorSample[] = [];
  for (let i = 0; i < row.successes; i++) {
    samples.push({
      taskId: `outcome:${row.personaId}:${row.skillId}:${row.taskSignature}:s${i}`,
      taskSignature: row.taskSignature,
      compositeError: SUCCESS_COMPOSITE_ERROR,
      outcome: 'success',
      ts: row.lastOutcomeAt - (total - i - 1),
      personaId: row.personaId,
    });
  }
  for (let i = 0; i < row.failures; i++) {
    samples.push({
      taskId: `outcome:${row.personaId}:${row.skillId}:${row.taskSignature}:f${i}`,
      taskSignature: row.taskSignature,
      compositeError: FAILURE_COMPOSITE_ERROR,
      outcome: 'failure',
      ts: row.lastOutcomeAt - (row.failures - i - 1),
      personaId: row.personaId,
    });
  }
  return samples;
}
