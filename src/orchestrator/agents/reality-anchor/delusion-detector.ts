/**
 * DelusionDetector — Phase C2 reality-anchor.
 *
 * Compares a persona's recent fact citations (from the C1 ledger) against
 * file hashes the CURRENT verify cycle is reporting. When a citation's
 * `cited_at_hash` no longer matches the current hash for the same target,
 * the persona's belief is **stale** — they "remember" the file at a hash
 * that no longer exists. That's a delusion candidate.
 *
 * Scope decision (vs `PersonaFactCitationsStore.listStaleForPersona`):
 *
 *   - `listStaleForPersona` treats `currentHash === undefined` as
 *     **stale** (gone-source). Useful for sleep-cycle batch audits where
 *     you have full-workspace hash coverage.
 *   - `detectDelusions` (this module) treats `currentHash === undefined`
 *     as **out-of-scope** for the current verify cycle and skips it.
 *     Phase-verify only knows hashes for files this cycle touched, so
 *     conflating "not in scope" with "stale" would falsely flag every
 *     historical citation. Out-of-scope citations get their delusion
 *     check on the NEXT verify that touches them.
 *
 * Pure function + injected dependencies (A3-friendly, deterministic):
 * caller passes a callback for recent citations + the in-cycle hash map.
 * No DB read, no network — testable in isolation, replayable from a
 * trace.
 *
 * Attenuation contract:
 *   delusionRate = uniqueStaleCount / scopedCount
 *   attenuation  = max(MIN_ATTENUATION, 1 - delusionRate)
 *   newConfidence = oldConfidence * attenuation
 *
 * Floor of 0.5 prevents a single severely-stale persona from
 * collapsing confidence to zero — the deliberation gate then has the
 * room to escalate appropriately. Tunable via `psychosis.delusion_ceiling`
 * if the operator wants stricter semantics.
 */

import type { PersonaFactCitationRecord } from '../../../db/persona-fact-citations-store.ts';

export interface FalsifiedCitation {
  readonly factId: string;
  readonly citedAtHash: string;
  readonly currentHash: string;
  readonly citedAtTs: number;
  readonly taskId: string;
  readonly claimExcerpt: string;
}

export interface DelusionDetectionResult {
  readonly kind: 'consistent' | 'delusion';
  readonly falsified: readonly FalsifiedCitation[];
  /**
   * Citations whose `factId` was actually checked against the current
   * cycle's hashes. Out-of-scope citations are NOT counted here, so the
   * rate isn't diluted by historical noise.
   */
  readonly scopedCount: number;
  /**
   * `falsified.length / scopedCount` (0 when scopedCount === 0). Drives
   * confidence attenuation and feeds PsychosisMonitor's delusionRate
   * signal.
   */
  readonly delusionRate: number;
  /**
   * Multiplier applied to verificationConfidence by `attenuateConfidence`.
   * Returned alongside the detection so phase-verify's bus event can
   * surface it for audit consumers.
   */
  readonly attenuation: number;
}

export interface DetectDelusionsInput {
  readonly personaId: string;
  /**
   * Recent citation provider — typically `() =>
   * personaFactCitationsStore.listForPersona(personaId, 1000)`.
   * Returns rows newest-first; the detector dedupes to latest-per-fact.
   */
  readonly recentCitations: () => readonly PersonaFactCitationRecord[];
  /**
   * Path/symbol → current hash map for files in scope this verify cycle.
   * Built by phase-verify from `verification.verdicts[*].fileHashes`.
   * Citations whose factId is NOT in this map are out-of-scope and
   * skipped entirely.
   */
  readonly currentFileHashes: ReadonlyMap<string, string>;
}

const MIN_ATTENUATION = 0.5;

export function detectDelusions(input: DetectDelusionsInput): DelusionDetectionResult {
  const candidates = input.recentCitations();
  // Newest-first input → first-seen-per-factId is the latest citation.
  // Skip subsequent rows for the same factId so a persona that cited the
  // same fact 10 times isn't checked 10 times — only their latest belief
  // matters.
  const seenFacts = new Set<string>();
  const falsified: FalsifiedCitation[] = [];
  let scopedCount = 0;

  for (const c of candidates) {
    if (seenFacts.has(c.factId)) continue;
    seenFacts.add(c.factId);

    const current = input.currentFileHashes.get(c.factId);
    if (current === undefined) continue; // out of scope this cycle — skip
    scopedCount++;
    if (c.citedAtHash === current) continue; // belief still consistent

    falsified.push({
      factId: c.factId,
      citedAtHash: c.citedAtHash,
      currentHash: current,
      citedAtTs: c.citedAtTs,
      taskId: c.taskId,
      claimExcerpt: c.claimExcerpt,
    });
  }

  const delusionRate = scopedCount === 0 ? 0 : falsified.length / scopedCount;
  const attenuation = Math.max(MIN_ATTENUATION, 1 - delusionRate);

  return {
    kind: falsified.length > 0 ? 'delusion' : 'consistent',
    falsified,
    scopedCount,
    delusionRate,
    attenuation,
  };
}

/**
 * Apply the detection result's attenuation factor to a confidence
 * value. Pure helper — phase-verify uses this so the formula stays in
 * one place + A8 trace replay reproduces the exact same attenuated
 * value.
 */
export function attenuateForDelusion(confidence: number, result: DelusionDetectionResult): number {
  if (result.kind === 'consistent') return confidence;
  return confidence * result.attenuation;
}
