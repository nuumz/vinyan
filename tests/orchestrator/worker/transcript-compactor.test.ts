import { describe, expect, test } from 'bun:test';
import {
  buildCompactedTranscript,
  estimateTurnTokens,
  isEvidenceTurn,
  partitionTranscript,
} from '../../../src/orchestrator/agent/transcript-compactor.ts';

describe('EO #5: Transcript Compactor', () => {
  // ── isEvidenceTurn ───────────────────────────────────────────────

  test('classifies tool_results as evidence', () => {
    expect(isEvidenceTurn({ type: 'tool_results', results: [] })).toBe(true);
  });

  test('classifies tool_calls as evidence', () => {
    expect(isEvidenceTurn({ type: 'tool_calls', calls: [] })).toBe(true);
  });

  test('classifies text turns as narrative', () => {
    expect(isEvidenceTurn({ type: 'text', content: 'reasoning...' })).toBe(false);
  });

  test('classifies done as narrative', () => {
    expect(isEvidenceTurn({ type: 'done', proposedContent: 'result' })).toBe(false);
  });

  test('classifies uncertain as narrative', () => {
    expect(isEvidenceTurn({ type: 'uncertain', reason: 'not sure' })).toBe(false);
  });

  // ── estimateTurnTokens ──────────────────────────────────────────

  test('provides reasonable token estimates', () => {
    const smallTurn = { type: 'done', turnId: 't1' };
    const largeTurn = { type: 'tool_results', turnId: 't2', results: Array(100).fill({ data: 'x'.repeat(50) }) };

    const smallEstimate = estimateTurnTokens(smallTurn);
    const largeEstimate = estimateTurnTokens(largeTurn);

    expect(smallEstimate).toBeGreaterThan(0);
    expect(largeEstimate).toBeGreaterThan(smallEstimate);
    // JSON.stringify length / 4 heuristic — small turn ~8 tokens, large turn >>100
    expect(smallEstimate).toBeLessThan(50);
    expect(largeEstimate).toBeGreaterThan(100);
  });

  // ── partitionTranscript ─────────────────────────────────────────

  test('counts narrative vs evidence correctly', () => {
    const transcript = [
      { type: 'tool_calls', turnId: 't1', calls: [], rationale: 'read file' },
      { type: 'tool_results', turnId: 't1', results: [{ content: 'file data' }] },
      { type: 'done', turnId: 't2', proposedContent: 'analysis' },
    ];

    const partition = partitionTranscript(transcript);

    expect(partition.compactedNarrativeTurns).toBe(1); // only 'done'
    expect(partition.evidenceTurns).toHaveLength(3);

    const evidenceCount = partition.evidenceTurns.filter((t) => t.isEvidence).length;
    const narrativeCount = partition.evidenceTurns.filter((t) => !t.isEvidence).length;
    expect(evidenceCount).toBe(2); // tool_calls + tool_results
    expect(narrativeCount).toBe(1); // done
  });

  test('calculates token savings from narrative turns', () => {
    const transcript = [
      { type: 'tool_calls', turnId: 't1', tokensConsumed: 100 },
      { type: 'done', turnId: 't2', tokensConsumed: 500 },
      { type: 'uncertain', turnId: 't3', tokensConsumed: 200, reason: 'hmm', uncertainties: [] },
    ];

    const partition = partitionTranscript(transcript);

    // narrative = done(500) + uncertain(200) = 700
    expect(partition.tokensSaved).toBe(700);
    expect(partition.compactedNarrativeTurns).toBe(2);
  });

  test('uses estimateTurnTokens when tokensConsumed is missing', () => {
    const transcript = [
      { type: 'done', turnId: 't1', proposedContent: 'analysis result here' },
    ];

    const partition = partitionTranscript(transcript);

    // Should fall back to JSON.stringify / 4 heuristic
    expect(partition.tokensSaved).toBeGreaterThan(0);
    expect(partition.compactedNarrativeTurns).toBe(1);
  });

  test('generates turnId when missing', () => {
    const transcript = [
      { type: 'tool_calls' },
      { type: 'done' },
    ];

    const partition = partitionTranscript(transcript);

    expect(partition.evidenceTurns[0]!.turnId).toBe('turn-0');
    expect(partition.evidenceTurns[1]!.turnId).toBe('turn-1');
  });

  test('handles empty transcript', () => {
    const partition = partitionTranscript([]);

    expect(partition.evidenceTurns).toHaveLength(0);
    expect(partition.compactedNarrativeTurns).toBe(0);
    expect(partition.tokensSaved).toBe(0);
  });

  // ── buildCompactedTranscript ────────────────────────────────────

  test('keeps evidence turns and replaces narrative with summary', () => {
    const transcript = [
      { type: 'tool_calls', turnId: 't1', calls: [] },
      { type: 'done', turnId: 't2', proposedContent: 'long reasoning...' },
      { type: 'tool_results', turnId: 't3', results: [] },
    ];

    const compacted = buildCompactedTranscript(transcript, 'Agent analyzed the file.');

    expect(compacted).toHaveLength(3); // tool_calls + summary + tool_results
    expect(compacted[0]!.type).toBe('tool_calls');
    expect(compacted[1]!.type).toBe('compacted_summary');
    expect((compacted[1] as { content: string }).content).toBe('Agent analyzed the file.');
    expect(compacted[2]!.type).toBe('tool_results');
  });

  test('inserts summary placeholder only once for multiple narrative turns', () => {
    const transcript = [
      { type: 'done', turnId: 't1' },
      { type: 'uncertain', turnId: 't2', reason: 'x', uncertainties: [] },
      { type: 'tool_calls', turnId: 't3', calls: [] },
    ];

    const compacted = buildCompactedTranscript(transcript, 'Summary');

    // 1 summary + 1 tool_calls = 2
    expect(compacted).toHaveLength(2);
    expect(compacted[0]!.type).toBe('compacted_summary');
    expect(compacted[1]!.type).toBe('tool_calls');
  });

  test('returns empty when transcript is empty', () => {
    const compacted = buildCompactedTranscript([], 'No content');
    expect(compacted).toHaveLength(0);
  });

  test('returns only evidence when no narrative turns exist', () => {
    const transcript = [
      { type: 'tool_calls', turnId: 't1', calls: [] },
      { type: 'tool_results', turnId: 't2', results: [] },
    ];

    const compacted = buildCompactedTranscript(transcript, 'Should not appear');

    expect(compacted).toHaveLength(2);
    expect(compacted.every((t) => t.type === 'tool_calls' || t.type === 'tool_results')).toBe(true);
  });
});
