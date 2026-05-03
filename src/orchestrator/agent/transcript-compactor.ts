/**
 * EO #5: Dual-Track Transcript Compaction
 *
 * Partitions agent transcript into evidence (immutable) and narrative (compactable) turns.
 * Evidence turns contain tool results with file hashes, oracle verdicts — content-addressed
 * truth that must never be lost (A4). Narrative turns contain LLM reasoning that can be
 * summarized under budget pressure.
 *
 * This module is a pure function library — no LLM dependency. The caller (agent-loop)
 * decides when to compact and how to summarize narrative.
 */
import type { TranscriptPartition } from '../types.ts';

/** Rough token estimation for a turn based on JSON serialization length */
export function estimateTurnTokens(turn: { type: string; [key: string]: unknown }): number {
  return Math.ceil(JSON.stringify(turn).length / 4);
}

/**
 * Marker key recognized by `isEvidenceTurn`. Any turn carrying
 * `__preserveOnCompaction: true` survives compaction unchanged.
 *
 * Strategy decision (Task 4 — L2 transcript compaction survival):
 *   We picked Strategy (a) — explicit preserve channel — over (b)
 *   replay-after-compaction. Why (a):
 *   1. Compaction in `agent-loop.ts:1346` mutates a LOCAL transcript
 *      var; the running subprocess's LLM context is unaffected. So
 *      preservation is about RESUME semantics (init.turns on a fresh
 *      agent-loop), not active context. (a) is a single classification
 *      hook; (b) would need a redundant audit-log scan and inject
 *      reconstruction at compact time, with weaker provenance.
 *   2. Today's cot-injection lands its payload in `init.goal`, NOT in
 *      the transcript. Compaction therefore has no operational effect
 *      on cot continuity for L1 (debate within-agent reuse). The
 *      preserve channel is wired now so any future L2/L3 path that
 *      DOES emit a transcript-resident inject turn (e.g., a mid-loop
 *      "## resumed reasoning" reminder) can mark it preservable
 *      without re-touching the partition contract.
 *   3. The flag is non-invasive: turns that omit it behave exactly as
 *      before, so all existing partition tests remain green.
 */
export const COMPACTION_PRESERVE_FLAG = '__preserveOnCompaction' as const;

/**
 * Classify a turn as evidence or narrative.
 *
 * Evidence (A4 — content-addressed, immutable):
 *   - tool_results: contains file content, oracle verdicts, execution output
 *   - tool_calls: verification-related tool invocations (the request side of evidence)
 *   - any turn carrying `__preserveOnCompaction: true` (preserve channel,
 *     reserved for orchestrator-injected continuity payloads — see
 *     `COMPACTION_PRESERVE_FLAG` doc above).
 *
 * Narrative (compactable):
 *   - done: final LLM reasoning summary
 *   - uncertain: LLM uncertainty expression
 *   - text: free-form LLM reasoning (future turn type)
 */
export function isEvidenceTurn(turn: { type: string; [key: string]: unknown }): boolean {
  if (turn.type === 'tool_results' || turn.type === 'tool_calls') return true;
  if (turn[COMPACTION_PRESERVE_FLAG] === true) return true;
  return false;
}

/**
 * Partition transcript into evidence (immutable) and narrative (compactable) turns.
 * Returns the partition without actually compacting — caller decides what to do.
 *
 * @param transcript - Array of turns from the agent session
 * @returns Partition with evidence inventory and narrative token savings
 */
export function partitionTranscript(
  transcript: Array<{ type: string; turnId?: string; tokensConsumed?: number; [key: string]: unknown }>,
): TranscriptPartition {
  let narrativeTurns = 0;
  let narrativeTokens = 0;
  const evidenceTurns: TranscriptPartition['evidenceTurns'] = [];

  for (const turn of transcript) {
    const isEvidence = isEvidenceTurn(turn);
    evidenceTurns.push({
      turnId: turn.turnId ?? `turn-${evidenceTurns.length}`,
      type: turn.type,
      isEvidence,
    });
    if (!isEvidence) {
      narrativeTurns++;
      narrativeTokens += turn.tokensConsumed ?? estimateTurnTokens(turn);
    }
  }

  return {
    evidenceTurns,
    compactedNarrativeTurns: narrativeTurns,
    tokensSaved: narrativeTokens,
  };
}

/**
 * Build a compacted transcript: keep all evidence turns as-is,
 * replace narrative turns with a single summary placeholder.
 *
 * @param transcript - Original full transcript
 * @param narrativeSummary - Caller-provided summary of narrative turns
 * @returns New transcript array with narrative replaced by single summary entry
 */
export function buildCompactedTranscript<T extends { type: string }>(
  transcript: T[],
  narrativeSummary: string,
): Array<T | { type: 'compacted_summary'; content: string }> {
  const result: Array<T | { type: 'compacted_summary'; content: string }> = [];
  let narrativeInserted = false;

  for (const turn of transcript) {
    if (isEvidenceTurn(turn)) {
      result.push(turn);
    } else if (!narrativeInserted) {
      result.push({ type: 'compacted_summary', content: narrativeSummary });
      narrativeInserted = true;
    }
    // skip remaining narrative turns (already summarized)
  }

  return result;
}
