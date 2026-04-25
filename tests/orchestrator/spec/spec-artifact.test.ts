import { describe, expect, test } from 'bun:test';
import {
  AcceptanceCriterionSchema,
  EdgeCaseSchema,
  isSpecApproved,
  SPEC_ARTIFACT_VERSION,
  SpecArtifactSchema,
  specToAcceptanceCriteriaList,
  specToConstraintsList,
  type SpecArtifact,
} from '../../../src/orchestrator/spec/spec-artifact.ts';

function makeSpec(overrides: Partial<SpecArtifact> = {}): SpecArtifact {
  const base: SpecArtifact = {
    version: SPEC_ARTIFACT_VERSION,
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
