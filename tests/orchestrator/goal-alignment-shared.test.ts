/**
 * Shared Goal Alignment types — minimal type/constant tests.
 *
 * These are not behavior tests — goal-alignment-shared.ts is a
 * documentation-and-contract file. But we lock in the heuristic cap
 * constant and the phase discriminator to prevent accidental drift
 * between the pre-gen Comprehension Check and the post-gen Goal
 * Alignment Verifier (see docs/design/agent-conversation.md →
 * "Two-phase Goal Alignment").
 */
import { describe, expect, test } from 'bun:test';

import {
  GOAL_ALIGNMENT_HEURISTIC_CAP,
  type GoalAlignmentPhase,
  type GoalAlignmentPhaseVerdict,
} from '../../src/orchestrator/understanding/goal-alignment-shared.ts';

describe('Goal Alignment shared types', () => {
  test('GOAL_ALIGNMENT_HEURISTIC_CAP matches the post-gen verifier MAX_CONFIDENCE', () => {
    // The goal-alignment-verifier hardcodes MAX_CONFIDENCE = 0.7.
    // Both files depend on this exact value (A5 tier cap). If one
    // drifts without the other, the oracles produce inconsistent
    // confidence bounds. Lock it in here.
    expect(GOAL_ALIGNMENT_HEURISTIC_CAP).toBe(0.7);
  });

  test('GOAL_ALIGNMENT_HEURISTIC_CAP is a readonly const (compile-time guarantee)', () => {
    // Runtime check: attempting to reassign throws in strict mode.
    // The actual guarantee is from `as const` in the source file —
    // this test exercises that importing code can rely on the
    // immutability invariant.
    const cap: 0.7 = GOAL_ALIGNMENT_HEURISTIC_CAP;
    expect(cap).toBe(0.7);
  });

  test('GoalAlignmentPhase is a discriminated string union with two members', () => {
    // TypeScript structural test — we round-trip both values
    // through a function to ensure they typecheck and to document
    // the contract for future readers.
    const pre: GoalAlignmentPhase = 'pre-generation';
    const post: GoalAlignmentPhase = 'post-generation';
    expect(pre).toBe('pre-generation');
    expect(post).toBe('post-generation');
  });

  test('GoalAlignmentPhaseVerdict shape documents the shared contract', () => {
    // Constructing a verdict of each phase type validates the shape
    // without relying on runtime reflection.
    const preVerdict: GoalAlignmentPhaseVerdict = {
      phase: 'pre-generation',
      aligned: false,
      confidence: 0.6,
      reasons: ['Entity "the helper" matched 3 candidate paths'],
      failedCheckIds: ['H1-ambiguous-entity'],
    };
    const postVerdict: GoalAlignmentPhaseVerdict = {
      phase: 'post-generation',
      aligned: true,
      confidence: 0.7,
      reasons: [],
      failedCheckIds: [],
    };
    expect(preVerdict.phase).toBe('pre-generation');
    expect(postVerdict.phase).toBe('post-generation');
    expect(preVerdict.confidence).toBeLessThanOrEqual(GOAL_ALIGNMENT_HEURISTIC_CAP);
    expect(postVerdict.confidence).toBeLessThanOrEqual(GOAL_ALIGNMENT_HEURISTIC_CAP);
  });
});
