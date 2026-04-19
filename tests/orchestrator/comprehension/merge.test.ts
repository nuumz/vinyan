/**
 * Tests for the A5 merge rule — rule + LLM envelopes → single hybrid.
 * Locks the invariants: conservative tier, state from s1, enrichment
 * only when s1 couldn't anchor, fail-safe on mismatches.
 */

import { describe, expect, test } from 'bun:test';
import { mergeComprehensions } from '../../../src/orchestrator/comprehension/merge.ts';
import type {
  ComprehendedTaskMessage,
  ComprehensionTier,
} from '../../../src/orchestrator/comprehension/types.ts';

function baseEnv(
  overrides: Partial<{
    type: 'comprehension' | 'unknown';
    tier: ComprehensionTier;
    confidence: number;
    inputHash: string;
    literalGoal: string;
    resolvedGoal: string;
    priorContextSummary: string;
    rootGoal: string | null;
    isClarificationAnswer: boolean;
    hasAmbiguousReferents: boolean;
    evidenceSource: string;
  }> = {},
): ComprehendedTaskMessage {
  const t = overrides.type ?? 'comprehension';
  const tier = overrides.tier ?? 'deterministic';
  const conf = overrides.confidence ?? 1;
  const literal = overrides.literalGoal ?? 'original goal';
  const resolved = overrides.resolvedGoal ?? literal;

  const base: ComprehendedTaskMessage = {
    jsonrpc: '2.0',
    method: 'comprehension.result',
    params: {
      type: t,
      confidence: conf,
      tier,
      evidence_chain: [
        { source: overrides.evidenceSource ?? 'rule:test', claim: 'test', confidence: 1 },
      ],
      falsifiable_by: ['test-falsifier'],
      temporal_context: { as_of: 1000, valid_until: 2000 },
      inputHash: overrides.inputHash ?? 'h1',
      rootGoal: overrides.rootGoal ?? null,
      data:
        t === 'unknown'
          ? undefined
          : {
              literalGoal: literal,
              resolvedGoal: resolved,
              state: {
                isNewTopic: false,
                isClarificationAnswer: overrides.isClarificationAnswer ?? false,
                isFollowUp: true,
                hasAmbiguousReferents: overrides.hasAmbiguousReferents ?? false,
                pendingQuestions: [],
                rootGoal: overrides.rootGoal ?? null,
              },
              priorContextSummary: overrides.priorContextSummary ?? 'short rule-based summary',
              memoryLaneRelevance: {},
            },
    },
  };
  return base;
}

describe('mergeComprehensions', () => {
  test('hash mismatch → s1 unchanged, declineReason=hash-mismatch', () => {
    const s1 = baseEnv({ inputHash: 'h1' });
    const s2 = baseEnv({ inputHash: 'h2' });
    const result = mergeComprehensions(s1, s2);
    expect(result.envelope).toBe(s1);
    expect(result.s2Contributed).toBe(false);
    expect(result.declineReason).toBe('hash-mismatch');
  });

  test('s2 unknown → s1 unchanged, declineReason=s2-unknown', () => {
    const s1 = baseEnv();
    const s2 = baseEnv({ type: 'unknown' });
    const result = mergeComprehensions(s1, s2);
    expect(result.envelope).toBe(s1);
    expect(result.s2Contributed).toBe(false);
  });

  test('s1 unknown → returns s1 with merged evidence (both chains preserved)', () => {
    const s1 = baseEnv({ type: 'unknown', evidenceSource: 'rule:empty' });
    const s2 = baseEnv({ evidenceSource: 'llm:advisory' });
    const result = mergeComprehensions(s1, s2);
    expect(result.s2Contributed).toBe(false);
    expect(result.declineReason).toBe('s1-unknown');
    expect(result.envelope.params.type).toBe('unknown');
    const sources = result.envelope.params.evidence_chain.map((e) => e.source);
    expect(sources).toContain('rule:empty');
    expect(sources).toContain('llm:advisory');
  });

  test('tier is the LOWER of s1/s2 (A5 conservative)', () => {
    const s1 = baseEnv({ tier: 'deterministic', confidence: 1 });
    const s2 = baseEnv({ tier: 'probabilistic', confidence: 0.4 });
    const result = mergeComprehensions(s1, s2);
    expect(result.envelope.params.tier).toBe('probabilistic');
  });

  test('confidence is min(s1, s2)', () => {
    const s1 = baseEnv({ confidence: 0.9 });
    const s2 = baseEnv({ tier: 'probabilistic', confidence: 0.3 });
    const result = mergeComprehensions(s1, s2);
    expect(result.envelope.params.confidence).toBe(0.3);
  });

  test('state flags stay from s1 (A6 governance signals)', () => {
    const s1 = baseEnv({
      isClarificationAnswer: true,
      hasAmbiguousReferents: false,
    });
    const s2 = baseEnv({
      tier: 'probabilistic',
      confidence: 0.3,
      // LLM's state should be IGNORED — s1's flags are deterministic.
      isClarificationAnswer: false,
      hasAmbiguousReferents: true,
    });
    const result = mergeComprehensions(s1, s2);
    expect(result.envelope.params.data?.state.isClarificationAnswer).toBe(true);
    expect(result.envelope.params.data?.state.hasAmbiguousReferents).toBe(false);
  });

  test('resolvedGoal: enrich ONLY when s1 could not anchor', () => {
    // Case 1: s1 anchored → keep s1's resolvedGoal.
    const s1Anchored = baseEnv({
      literalGoal: 'ok',
      resolvedGoal: 'write a bedtime story',
    });
    const s2Anchored = baseEnv({
      tier: 'probabilistic',
      confidence: 0.4,
      literalGoal: 'ok',
      resolvedGoal: 'something completely different',
    });
    expect(
      mergeComprehensions(s1Anchored, s2Anchored).envelope.params.data?.resolvedGoal,
    ).toBe('write a bedtime story');

    // Case 2: s1 couldn't anchor (resolvedGoal === literalGoal) → s2 wins.
    const s1Stuck = baseEnv({
      literalGoal: 'ok',
      resolvedGoal: 'ok', // couldn't anchor
    });
    const s2Helps = baseEnv({
      tier: 'probabilistic',
      confidence: 0.4,
      literalGoal: 'ok',
      resolvedGoal: 'resumed prior task', // LLM resolved it
    });
    expect(
      mergeComprehensions(s1Stuck, s2Helps).envelope.params.data?.resolvedGoal,
    ).toBe('resumed prior task');
  });

  test('priorContextSummary: LLM enriches (longer one wins)', () => {
    const s1 = baseEnv({ priorContextSummary: 'short' });
    const s2 = baseEnv({
      tier: 'probabilistic',
      confidence: 0.5,
      priorContextSummary: 'a much longer summary with more context',
    });
    expect(
      mergeComprehensions(s1, s2).envelope.params.data?.priorContextSummary,
    ).toBe('a much longer summary with more context');
  });

  test('evidence chains from both sides concatenate', () => {
    const s1 = baseEnv({ evidenceSource: 'rule:one' });
    const s2 = baseEnv({
      tier: 'probabilistic',
      confidence: 0.5,
      evidenceSource: 'llm:two',
    });
    const result = mergeComprehensions(s1, s2);
    expect(result.envelope.params.evidence_chain).toHaveLength(2);
    const sources = result.envelope.params.evidence_chain.map((e) => e.source);
    expect(sources).toEqual(['rule:one', 'llm:two']);
  });

  test('falsifiable_by is a union (dedup)', () => {
    const s1 = baseEnv();
    // Forge a s2 with partial overlap.
    const s2: ComprehendedTaskMessage = {
      ...baseEnv({ tier: 'probabilistic', confidence: 0.5 }),
    };
    s2.params = {
      ...s2.params,
      falsifiable_by: ['test-falsifier', 'llm-specific-falsifier'],
    };
    const result = mergeComprehensions(s1, s2);
    expect(new Set(result.envelope.params.falsifiable_by)).toEqual(
      new Set(['test-falsifier', 'llm-specific-falsifier']),
    );
  });

  test('temporal_context: min as_of + min valid_until (narrower window)', () => {
    const s1 = baseEnv();
    const s2: ComprehendedTaskMessage = {
      ...baseEnv({ tier: 'probabilistic', confidence: 0.5 }),
    };
    s2.params = {
      ...s2.params,
      temporal_context: { as_of: 500, valid_until: 1500 },
    };
    const result = mergeComprehensions(s1, s2);
    expect(result.envelope.params.temporal_context.as_of).toBe(500); // earlier
    expect(result.envelope.params.temporal_context.valid_until).toBe(1500); // narrower
  });
});
