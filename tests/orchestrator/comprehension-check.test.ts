/**
 * Comprehension Check unit tests.
 *
 * Exercises the pure-function orchestrator gate introduced by the
 * Goal Alignment Oracle integration PR. Tests isolate each heuristic
 * (H1 multi-path entity, H4 contradictory claim) and the composite /
 * opt-out behaviors.
 *
 * End-to-end integration through the core-loop pipeline is not
 * tested here — the in-process harness can't exercise the agent-loop
 * path. Integration happens at the unit boundary (this file) and
 * the core-loop short-circuit (shared trace/event shape with the
 * existing agent-driven path, already covered by
 * tests/orchestrator/clarification.test.ts).
 */
import { describe, expect, it } from 'bun:test';
import {
  checkComprehension,
  COMPREHENSION_CHECK_OFF_CONSTRAINT,
  isComprehensionCheckDisabled,
} from '../../src/orchestrator/understanding/comprehension-check.ts';
import type {
  ResolvedEntity,
  SemanticTaskUnderstanding,
  TaskUnderstanding,
  VerifiedClaim,
} from '../../src/orchestrator/types.ts';

function makeBaseUnderstanding(
  overrides: Partial<TaskUnderstanding> = {},
): TaskUnderstanding {
  return {
    rawGoal: 'do something',
    actionVerb: 'modify',
    actionCategory: 'mutation',
    frameworkContext: [],
    constraints: [],
    acceptanceCriteria: [],
    expectsMutation: true,
    ...overrides,
  };
}

function makeSemanticUnderstanding(
  overrides: Partial<SemanticTaskUnderstanding> = {},
): SemanticTaskUnderstanding {
  return {
    ...makeBaseUnderstanding(),
    taskDomain: 'code-mutation',
    taskIntent: 'execute',
    toolRequirement: 'tool-needed',
    resolvedEntities: [],
    understandingDepth: 1,
    verifiedClaims: [],
    understandingFingerprint: 'fp-test',
    ...overrides,
  };
}

function makeEntity(overrides: Partial<ResolvedEntity> = {}): ResolvedEntity {
  return {
    reference: 'the helper',
    resolvedPaths: ['src/helper.ts'],
    resolution: 'exact',
    confidence: 0.95,
    confidenceSource: 'evidence-derived',
    ...overrides,
  };
}

function makeClaim(overrides: Partial<VerifiedClaim> = {}): VerifiedClaim {
  return {
    claim: 'File src/foo.ts exists',
    type: 'known',
    confidence: 0.95,
    confidenceSource: 'evidence-derived',
    tierReliability: 0.95,
    falsifiableBy: [],
    evidence: [],
    ...overrides,
  };
}

describe('checkComprehension — confident baseline', () => {
  it('returns confident when given a fully unambiguous understanding', () => {
    const u = makeSemanticUnderstanding({
      resolvedEntities: [makeEntity()],
      verifiedClaims: [makeClaim()],
    });
    const verdict = checkComprehension(u);
    expect(verdict.confident).toBe(true);
    expect(verdict.confidence).toBe(1);
    expect(verdict.questions).toEqual([]);
    expect(verdict.failedChecks).toEqual([]);
  });

  it('handles a plain TaskUnderstanding (no semantic fields) without throwing', () => {
    // Callers at L0/L1 may pass a base TaskUnderstanding with no
    // resolvedEntities / verifiedClaims fields. The check must
    // treat missing arrays as empty and return confident.
    const u = makeBaseUnderstanding({
      actionCategory: 'mutation',
      expectsMutation: true,
    });
    const verdict = checkComprehension(u);
    expect(verdict.confident).toBe(true);
    expect(verdict.questions).toEqual([]);
  });
});

// ── H1: multi-path ambiguous entity ─────────────────────────────────

describe('checkComprehension — H1 multi-path ambiguous entity', () => {
  it('fires when an entity has >1 resolved paths and low confidence', () => {
    const u = makeSemanticUnderstanding({
      resolvedEntities: [
        makeEntity({
          reference: 'the helper',
          resolvedPaths: ['src/auth/helper.ts', 'src/utils/helper.ts', 'src/db/helper.ts'],
          confidence: 0.4,
          resolution: 'fuzzy-path',
        }),
      ],
    });
    const verdict = checkComprehension(u);
    expect(verdict.confident).toBe(false);
    expect(verdict.failedChecks).toHaveLength(1);
    expect(verdict.failedChecks[0]!.check).toBe('H1-ambiguous-entity');
    expect(verdict.questions).toHaveLength(1);
    const q = verdict.questions[0]!;
    expect(q).toContain('the helper');
    expect(q).toContain('src/auth/helper.ts');
    expect(q).toContain('src/utils/helper.ts');
    expect(q).toContain('src/db/helper.ts');
  });

  it('does NOT fire when a multi-path entity has high confidence', () => {
    // The entity resolver confidently picked one; the remaining paths
    // are alternatives kept for audit but the primary is trusted.
    const u = makeSemanticUnderstanding({
      resolvedEntities: [
        makeEntity({
          reference: 'auth',
          resolvedPaths: ['src/auth/index.ts', 'src/auth/helper.ts'],
          confidence: 0.9,
        }),
      ],
    });
    const verdict = checkComprehension(u);
    expect(verdict.confident).toBe(true);
  });

  it('does NOT fire on a single-path entity regardless of confidence', () => {
    // One path means there is no ambiguity — nothing to disambiguate.
    const u = makeSemanticUnderstanding({
      resolvedEntities: [
        makeEntity({
          reference: 'the module',
          resolvedPaths: ['src/mod.ts'],
          confidence: 0.3,
        }),
      ],
    });
    const verdict = checkComprehension(u);
    expect(verdict.confident).toBe(true);
  });

  it('truncates the candidate list in the question when >maxPathsPerQuestion', () => {
    const u = makeSemanticUnderstanding({
      resolvedEntities: [
        makeEntity({
          reference: 'the thing',
          resolvedPaths: ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'],
          confidence: 0.3,
        }),
      ],
    });
    const verdict = checkComprehension(u, { maxPathsPerQuestion: 3 });
    const q = verdict.questions[0]!;
    expect(q).toContain('a.ts');
    expect(q).toContain('b.ts');
    expect(q).toContain('c.ts');
    expect(q).toContain('...');
    // d/e/f should not appear
    expect(q).not.toContain('d.ts');
  });

  it('respects a custom entityConfidenceThreshold', () => {
    const entity = makeEntity({
      reference: 'foo',
      resolvedPaths: ['a.ts', 'b.ts'],
      confidence: 0.7,
    });
    // Default threshold is 0.6 — 0.7 is above → confident
    expect(checkComprehension(makeSemanticUnderstanding({ resolvedEntities: [entity] })).confident).toBe(
      true,
    );
    // Raise threshold to 0.8 — now 0.7 is below → fires
    expect(
      checkComprehension(makeSemanticUnderstanding({ resolvedEntities: [entity] }), {
        entityConfidenceThreshold: 0.8,
      }).confident,
    ).toBe(false);
  });
});

// Note: H3 (verb-mutation mismatch) was considered for V1 but deferred —
// the current rule-based action-category classifier is too coarse
// (verbs like "test" map to category='qa' which false-positives against
// taskType='code' inputs). See comprehension-check.ts module docstring.

// ── H4: contradictory claims ────────────────────────────────────────

describe('checkComprehension — H4 contradictory verified claims', () => {
  it('fires when one verifiedClaim has type=contradictory', () => {
    const u = makeSemanticUnderstanding({
      verifiedClaims: [
        makeClaim({ claim: 'File src/foo.ts exists', type: 'contradictory' }),
      ],
    });
    const verdict = checkComprehension(u);
    expect(verdict.confident).toBe(false);
    expect(verdict.failedChecks[0]!.check).toBe('H4-contradictory-claim');
    expect(verdict.questions[0]!).toContain('src/foo.ts');
  });

  it('does NOT fire on claims with type=known / unknown / uncertain', () => {
    const u = makeSemanticUnderstanding({
      verifiedClaims: [
        makeClaim({ claim: 'A', type: 'known' }),
        makeClaim({ claim: 'B', type: 'unknown' }),
        makeClaim({ claim: 'C', type: 'uncertain' }),
      ],
    });
    expect(checkComprehension(u).confident).toBe(true);
  });

  it('caps at 3 questions when many contradictions exist', () => {
    const u = makeSemanticUnderstanding({
      verifiedClaims: [
        makeClaim({ claim: 'X1', type: 'contradictory' }),
        makeClaim({ claim: 'X2', type: 'contradictory' }),
        makeClaim({ claim: 'X3', type: 'contradictory' }),
        makeClaim({ claim: 'X4', type: 'contradictory' }),
        makeClaim({ claim: 'X5', type: 'contradictory' }),
      ],
    });
    const verdict = checkComprehension(u);
    expect(verdict.confident).toBe(false);
    // 3 questions emitted, 3 checks recorded — the 4th and 5th are dropped.
    expect(verdict.questions).toHaveLength(3);
    expect(verdict.failedChecks).toHaveLength(3);
  });
});

// ── Composite + confidence score ────────────────────────────────────

describe('checkComprehension — composite verdicts', () => {
  it('combines multiple failed heuristics into one verdict', () => {
    const u = makeSemanticUnderstanding({
      resolvedEntities: [
        makeEntity({
          reference: 'helper',
          resolvedPaths: ['a.ts', 'b.ts'],
          confidence: 0.3,
        }),
      ],
      verifiedClaims: [makeClaim({ type: 'contradictory' })],
    });
    const verdict = checkComprehension(u);
    expect(verdict.confident).toBe(false);
    expect(verdict.failedChecks).toHaveLength(2);
    expect(verdict.failedChecks.map((c) => c.check).sort()).toEqual([
      'H1-ambiguous-entity',
      'H4-contradictory-claim',
    ]);
    expect(verdict.questions).toHaveLength(2);
  });

  it('derives confidence as 1 - 0.2 * failedCount', () => {
    const zero = checkComprehension(makeSemanticUnderstanding());
    expect(zero.confidence).toBe(1);

    const oneFailure = checkComprehension(
      makeSemanticUnderstanding({
        verifiedClaims: [makeClaim({ type: 'contradictory' })],
      }),
    );
    expect(oneFailure.confidence).toBeCloseTo(0.8, 5);

    const twoFailures = checkComprehension(
      makeSemanticUnderstanding({
        resolvedEntities: [
          makeEntity({
            reference: 'helper',
            resolvedPaths: ['a.ts', 'b.ts'],
            confidence: 0.3,
          }),
        ],
        verifiedClaims: [makeClaim({ type: 'contradictory' })],
      }),
    );
    expect(twoFailures.confidence).toBeCloseTo(0.6, 5);
  });
});

// ── Opt-out ────────────────────────────────────────────────────────

describe('isComprehensionCheckDisabled', () => {
  it('returns true when COMPREHENSION_CHECK:off is in constraints', () => {
    expect(isComprehensionCheckDisabled([COMPREHENSION_CHECK_OFF_CONSTRAINT])).toBe(true);
  });

  it('returns true when the constraint is mixed with other constraints', () => {
    expect(
      isComprehensionCheckDisabled([
        'MIN_ROUTING_LEVEL:2',
        COMPREHENSION_CHECK_OFF_CONSTRAINT,
        'THINKING:enabled',
      ]),
    ).toBe(true);
  });

  it('returns false when constraints is undefined or empty', () => {
    expect(isComprehensionCheckDisabled(undefined)).toBe(false);
    expect(isComprehensionCheckDisabled([])).toBe(false);
  });

  it('returns false when only other constraints are present', () => {
    expect(isComprehensionCheckDisabled(['MIN_ROUTING_LEVEL:1'])).toBe(false);
  });
});
