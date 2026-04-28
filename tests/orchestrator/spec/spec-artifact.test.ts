import { describe, expect, test } from 'bun:test';
import {
  AcceptanceCriterionSchema,
  EdgeCaseSchema,
  isSpecApproved,
  SPEC_ARTIFACT_VERSION,
  type SpecArtifact,
  type SpecArtifactCode,
  SpecArtifactSchema,
  specToAcceptanceCriteriaList,
  specToConstraintsList,
} from '../../../src/orchestrator/spec/spec-artifact.ts';

function makeSpec(overrides: Partial<SpecArtifactCode> = {}): SpecArtifactCode {
  const base: SpecArtifactCode = {
    version: SPEC_ARTIFACT_VERSION,
    variant: 'code' as const,
    summary: 'Add budget tracker for per-task cost accounting.',
    acceptanceCriteria: [
      { id: 'ac-1', description: 'Cost ledger writes a row per task', testable: true, oracle: 'test' },
      { id: 'ac-2', description: 'Exceeding budget returns budget-exceeded error', testable: true, oracle: 'ast' },
      { id: 'ac-3', description: 'Subjective UX polish', testable: false, oracle: 'manual' },
    ],
    apiShape: [],
    dataContracts: [],
    edgeCases: [
      { id: 'ec-1', scenario: 'Budget is 0', expected: 'Reject immediately', severity: 'blocker' },
      { id: 'ec-2', scenario: 'Budget overflow', expected: 'Clamp to max int', severity: 'minor' },
    ],
    openQuestions: [],
  };
  return { ...base, ...overrides };
}

describe('SpecArtifactSchema', () => {
  test('accepts a well-formed spec', () => {
    const result = SpecArtifactSchema.safeParse(makeSpec());
    expect(result.success).toBe(true);
  });

  test('rejects empty acceptance criteria', () => {
    const result = SpecArtifactSchema.safeParse(makeSpec({ acceptanceCriteria: [] }));
    expect(result.success).toBe(false);
  });

  test('rejects more than 20 acceptance criteria', () => {
    const tooMany = Array.from({ length: 21 }, (_, i) => ({
      id: `ac-${i}`,
      description: `Criterion ${i}`,
      testable: true,
      oracle: 'test' as const,
    }));
    const result = SpecArtifactSchema.safeParse(makeSpec({ acceptanceCriteria: tooMany }));
    expect(result.success).toBe(false);
  });

  test('rejects unknown oracle value', () => {
    const bad = AcceptanceCriterionSchema.safeParse({
      id: 'x',
      description: 'y',
      testable: true,
      oracle: 'unknown-oracle',
    });
    expect(bad.success).toBe(false);
  });

  test('rejects invalid edge-case severity', () => {
    const bad = EdgeCaseSchema.safeParse({
      id: 'ec-x',
      scenario: 'boom',
      expected: 'recover',
      severity: 'catastrophic',
    });
    expect(bad.success).toBe(false);
  });

  test('rejects version other than the frozen constant', () => {
    const withBadVersion = { ...makeSpec(), version: '2' };
    const result = SpecArtifactSchema.safeParse(withBadVersion);
    expect(result.success).toBe(false);
  });
});

describe('specToAcceptanceCriteriaList', () => {
  test('returns only testable criteria as flat strings', () => {
    const spec = makeSpec();
    const list = specToAcceptanceCriteriaList(spec);
    expect(list).toEqual([
      'Cost ledger writes a row per task',
      'Exceeding budget returns budget-exceeded error',
    ]);
    expect(list.length).toBe(2); // non-testable was filtered
  });

  test('returns empty array when all criteria are non-testable', () => {
    const spec = makeSpec({
      acceptanceCriteria: [{ id: 'ac', description: 'Looks good', testable: false, oracle: 'manual' }],
    });
    expect(specToAcceptanceCriteriaList(spec)).toEqual([]);
  });
});

describe('specToConstraintsList', () => {
  test('prefixes blocker-severity edge cases with MUST:', () => {
    const spec = makeSpec();
    const constraints = specToConstraintsList(spec);
    expect(constraints[0]).toBe('MUST: Budget is 0 → Reject immediately');
    expect(constraints[1]).toBe('Budget overflow → Clamp to max int');
  });

  test('returns empty array when there are no edge cases', () => {
    const spec = makeSpec({ edgeCases: [] });
    expect(specToConstraintsList(spec)).toEqual([]);
  });
});

describe('isSpecApproved', () => {
  test('false when approvedBy/approvedAt are missing', () => {
    expect(isSpecApproved(makeSpec())).toBe(false);
  });

  test('true when both approvedBy and approvedAt are set', () => {
    expect(isSpecApproved(makeSpec({ approvedBy: 'human', approvedAt: Date.now() }))).toBe(true);
  });

  test('false when only approvedBy is set', () => {
    expect(isSpecApproved(makeSpec({ approvedBy: 'human' }))).toBe(false);
  });
});

// Gap C (2026-04-28): reasoning variant schema + projection.
describe('reasoning variant', () => {
  const baseReasoning: SpecArtifact = {
    version: SPEC_ARTIFACT_VERSION,
    variant: 'reasoning',
    summary: 'Compare three caching strategies for the order service.',
    acceptanceCriteria: [
      { id: 'ac-1', description: 'Each strategy listed with pros/cons', testable: true, oracle: 'goal-alignment' },
      { id: 'ac-2', description: 'Recommendation justified', testable: true, oracle: 'critic' },
    ],
    expectedDeliverables: [
      { kind: 'comparison', audience: 'platform engineer', format: 'table' },
    ],
    scopeBoundaries: {
      outOfScope: ['client-side caching'],
      assumptions: ['p95 read latency target is 50ms'],
    },
    edgeCases: [],
    openQuestions: [],
  };

  test('schema accepts a well-formed reasoning spec', () => {
    expect(SpecArtifactSchema.safeParse(baseReasoning).success).toBe(true);
  });

  test('reasoning variant rejects mechanical oracles (ast / type / test / lint / dep)', () => {
    const bad = {
      ...baseReasoning,
      acceptanceCriteria: [
        { id: 'ac-1', description: 'Pass tests', testable: true, oracle: 'test' as const },
      ],
    };
    expect(SpecArtifactSchema.safeParse(bad).success).toBe(false);
  });

  test('reasoning variant caps acceptance criteria at 7', () => {
    const tooMany = Array.from({ length: 8 }, (_, i) => ({
      id: `ac-${i}`,
      description: `criterion ${i}`,
      testable: true,
      oracle: 'goal-alignment' as const,
    }));
    const result = SpecArtifactSchema.safeParse({ ...baseReasoning, acceptanceCriteria: tooMany });
    expect(result.success).toBe(false);
  });

  test('schema preprocess defaults missing variant to "code" for backwards compat', () => {
    const persisted = {
      version: SPEC_ARTIFACT_VERSION,
      // variant intentionally omitted — simulates pre-Gap C persisted spec
      summary: 'Legacy spec without variant field',
      acceptanceCriteria: [
        { id: 'ac-1', description: 'Does the thing', testable: true, oracle: 'test' as const },
      ],
      apiShape: [],
      dataContracts: [],
      edgeCases: [],
      openQuestions: [],
    };
    const result = SpecArtifactSchema.safeParse(persisted);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.variant).toBe('code');
  });

  test('specToConstraintsList projects out-of-scope and assumptions for reasoning variant', () => {
    const constraints = specToConstraintsList(baseReasoning);
    expect(constraints).toContain('MUST: out-of-scope: client-side caching');
    expect(constraints).toContain('ASSUME: p95 read latency target is 50ms');
  });

  test('specToAcceptanceCriteriaList works variant-agnostically', () => {
    const list = specToAcceptanceCriteriaList(baseReasoning);
    expect(list).toEqual(['Each strategy listed with pros/cons', 'Recommendation justified']);
  });
});
