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
 * Classify a turn as evidence or narrative.
 *
 * Evidence (A4 — content-addressed, immutable):
 *   - tool_results: contains file content, oracle verdicts, execution output
 *   - tool_calls: verification-related tool invocations (the request side of evidence)
 *
 * Narrative (compactable):
 *   - done: final LLM reasoning summary
 *   - uncertain: LLM uncertainty expression
 *   - text: free-form LLM reasoning (future turn type)
 */
export function isEvidenceTurn(turn: { type: string; [key: string]: unknown }): boolean {
  return turn.type === 'tool_results' || turn.type === 'tool_calls';
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
