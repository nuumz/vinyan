/**
 * A3 — Deterministic Governance invariant.
 *
 * Routing/verification/commit decisions are rule-based — no LLM in the
 * governance path. The intent merger is the canonical example: when
 * deterministic and LLM disagree, the deterministic verdict wins on
 * tier order (A5), and the merger is a pure function (no I/O).
 */
import { describe, expect, test } from 'bun:test';
import { LLM_UNCERTAIN_THRESHOLD, isLLMRefinement } from '../../src/orchestrator/intent/merge.ts';

describe('A3 — Deterministic Governance', () => {
  test('LLM_UNCERTAIN_THRESHOLD is a deterministic constant', () => {
    expect(typeof LLM_UNCERTAIN_THRESHOLD).toBe('number');
    expect(LLM_UNCERTAIN_THRESHOLD).toBeGreaterThan(0);
    expect(LLM_UNCERTAIN_THRESHOLD).toBeLessThanOrEqual(1);
  });

  test('isLLMRefinement is pure — same input → same output', () => {
    const a = isLLMRefinement('agentic-workflow', 'full-pipeline');
    const b = isLLMRefinement('agentic-workflow', 'full-pipeline');
    expect(a).toBe(b);
  });

  test('isLLMRefinement returns true on identical strategies (agreement)', () => {
    expect(isLLMRefinement('agentic-workflow', 'agentic-workflow')).toBe(true);
    expect(isLLMRefinement('direct-tool', 'direct-tool')).toBe(true);
  });

  test('isLLMRefinement is false for arbitrary mismatches (true contradiction)', () => {
    // direct-tool vs full-pipeline is NOT an upgrade pair → contradiction.
    expect(isLLMRefinement('direct-tool', 'full-pipeline')).toBe(false);
  });
});
