import { describe, expect, test } from 'bun:test';
import {
  getApprovedCandidate,
  ideationToConstraint,
  IdeationCandidateSchema,
  IdeationResultSchema,
  type IdeationResult,
} from '../../../src/orchestrator/intent/ideation-types.ts';

function makeIdeation(overrides: Partial<IdeationResult> = {}): IdeationResult {
  const base: IdeationResult = {
    candidates: [
      {
        id: 'cand-0',
        title: 'Rewrite the SDK in Rust',
        approach: 'Port the current TS SDK to Rust with wasm bindings for web.',
        rationale: 'Perf + memory safety; avoids runtime GC jitter.',
        riskNotes: ['Team has no Rust experience'],
        estComplexity: 'large',
        score: 0.8,
      },
      {
        id: 'cand-1',
        title: 'Optimize hot path in existing TS',
        approach: 'Profile and tune the three hottest functions; add caching.',
        rationale: 'Low-risk incremental win.',
        riskNotes: [],
        estComplexity: 'small',
        score: 0.6,
      },
    ],
    rankedIds: ['cand-0', 'cand-1'],
    convergenceScore: 0.2,
  };
  return { ...base, ...overrides };
}

describe('IdeationCandidateSchema', () => {
  test('rejects negative score', () => {
    const result = IdeationCandidateSchema.safeParse({
      id: 'x',
      title: 'boom',
      approach: 'a plausible approach',
      rationale: 'why',
      riskNotes: [],
      estComplexity: 'small',
      score: -0.1,
    });
    expect(result.success).toBe(false);
  });

  test('rejects unknown complexity tag', () => {
    const result = IdeationCandidateSchema.safeParse({
      id: 'x',
      title: 'boom',
      approach: 'a plausible approach',
      rationale: 'why',
      riskNotes: [],
      estComplexity: 'massive',
      score: 0.5,
    });
    expect(result.success).toBe(false);
  });
});

describe('IdeationResultSchema', () => {
  test('accepts a well-formed ideation result', () => {
    const result = IdeationResultSchema.safeParse(makeIdeation());
    expect(result.success).toBe(true);
  });

  test('rejects fewer than 2 candidates', () => {
    const parsed = IdeationResultSchema.safeParse(
      makeIdeation({
        candidates: [
          {
            id: 'cand-0',
            title: 'only one',
            approach: 'does a thing',
            rationale: 'because',
            riskNotes: [],
            estComplexity: 'small',
            score: 0.5,
          },
        ],
        rankedIds: ['cand-0'],
      }),
    );
    expect(parsed.success).toBe(false);
  });

  test('rejects more than 6 candidates', () => {
    const candidates = Array.from({ length: 7 }, (_, i) => ({
      id: `cand-${i}`,
      title: `t-${i}`,
      approach: 'does a thing',
      rationale: 'because',
      riskNotes: [],
      estComplexity: 'small' as const,
      score: 0.5,
    }));
    const parsed = IdeationResultSchema.safeParse(
      makeIdeation({ candidates, rankedIds: candidates.map((c) => c.id) }),
    );
    expect(parsed.success).toBe(false);
  });
});

describe('getApprovedCandidate', () => {
  test('returns null when no candidate is approved', () => {
    expect(getApprovedCandidate(makeIdeation())).toBeNull();
  });

  test('returns the approved candidate when id exists', () => {
    const res = makeIdeation({ approvedCandidateId: 'cand-1' });
    const approved = getApprovedCandidate(res);
    expect(approved).not.toBeNull();
    expect(approved?.title).toBe('Optimize hot path in existing TS');
  });

  test('returns null when approvedCandidateId does not match any candidate', () => {
    const res = makeIdeation({ approvedCandidateId: 'cand-ghost' });
    expect(getApprovedCandidate(res)).toBeNull();
  });
});

describe('ideationToConstraint', () => {
  test('returns null when no candidate is approved', () => {
    expect(ideationToConstraint(makeIdeation())).toBeNull();
  });

  test('projects chosen candidate into APPROACH: constraint string', () => {
    const res = makeIdeation({ approvedCandidateId: 'cand-1' });
    expect(ideationToConstraint(res)).toBe(
      'APPROACH: Optimize hot path in existing TS — Profile and tune the three hottest functions; add caching.',
    );
  });

  test('includes riskNotes in the projected constraint when present', () => {
    const res = makeIdeation({ approvedCandidateId: 'cand-0' });
    const constraint = ideationToConstraint(res);
    expect(constraint).toContain('risks: Team has no Rust experience');
  });
});
