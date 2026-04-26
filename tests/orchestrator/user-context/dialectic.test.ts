/**
 * Tests for the USER.md dialectic update rule.
 *
 * Covers:
 *   - Below-threshold → no update.
 *   - Above revision threshold, no critic → tier demoted one step.
 *   - Above revision threshold, critic provided → revised with new prediction.
 *   - Above flip threshold → flipped to unknown (A2).
 *   - Tier-ladder correctness: heuristic → probabilistic, not skipped.
 *   - Speculative cannot demote further (boundary).
 *   - No observations → no-op.
 *   - Window slicing keeps only the most recent N observations.
 *   - Flip threshold dominates revision threshold (ordering).
 *   - Deterministic: same inputs → same outputs (A3).
 */
import { describe, expect, test } from 'bun:test';

import {
  applyDialectic,
  type DialecticCritic,
  type SectionObservation,
} from '../../../src/orchestrator/user-context/dialectic.ts';
import {
  UNKNOWN_PREDICTION_TEXT,
  type UserMdRecord,
  type UserMdSection,
} from '../../../src/orchestrator/user-context/user-md-schema.ts';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function section(
  overrides: Partial<UserMdSection> & { slug: string; heading: string; predictedResponse: string },
): UserMdSection {
  return {
    slug: overrides.slug,
    heading: overrides.heading,
    predictedResponse: overrides.predictedResponse,
    body: overrides.body ?? 'body',
    evidenceTier: overrides.evidenceTier ?? 'heuristic',
    confidence: overrides.confidence ?? 0.7,
    ...(overrides.lastRevisedAt !== undefined && { lastRevisedAt: overrides.lastRevisedAt }),
  };
}

function recordWith(sections: UserMdSection[]): UserMdRecord {
  return {
    frontmatter: { version: '1.0.0', profile: 'default' },
    sections,
  };
}

function observations(slug: string, deltas: number[], startTs = 1_700_000_000_000): SectionObservation[] {
  return deltas.map((delta, i) => ({
    slug,
    observed: `obs-${i}`,
    predicted: 'pred',
    delta,
    ts: startTs + i * 1_000,
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('applyDialectic — below threshold', () => {
  test('no-op when rolling error is below revision threshold', async () => {
    const record = recordWith([section({ slug: 'x', heading: 'X', predictedResponse: 'p' })]);
    const history = observations('x', [0.1, 0.2, 0.1, 0.05, 0.2]);
    const updates = await applyDialectic({ record, observationHistory: history });
    expect(updates).toHaveLength(1);
    expect(updates[0]!.kind).toBe('none');
    expect(updates[0]!.windowError).toBeLessThan(0.6);
    expect(updates[0]!.newPredictedResponse).toBeUndefined();
    expect(updates[0]!.newEvidenceTier).toBeUndefined();
  });

  test('empty history → none with zero window error', async () => {
    const record = recordWith([section({ slug: 'x', heading: 'X', predictedResponse: 'p' })]);
    const updates = await applyDialectic({ record, observationHistory: [] });
    expect(updates[0]!.kind).toBe('none');
    expect(updates[0]!.windowError).toBe(0);
    expect(updates[0]!.windowSize).toBe(0);
  });
});

describe('applyDialectic — demotion path (no critic)', () => {
  test('heuristic section demotes to probabilistic when error > revision threshold', async () => {
    const record = recordWith([
      section({ slug: 'x', heading: 'X', predictedResponse: 'p', evidenceTier: 'heuristic' }),
    ]);
    const history = observations('x', [0.7, 0.75, 0.8, 0.7, 0.7]);
    const updates = await applyDialectic({ record, observationHistory: history });
    expect(updates[0]!.kind).toBe('demoted');
    expect(updates[0]!.newEvidenceTier).toBe('probabilistic');
    expect(updates[0]!.newPredictedResponse).toBeUndefined(); // prediction unchanged
    expect(updates[0]!.newConfidence).toBeCloseTo(0.7 * 0.65);
  });

  test('probabilistic section demotes to speculative, not heuristic', async () => {
    const record = recordWith([
      section({
        slug: 'x',
        heading: 'X',
        predictedResponse: 'p',
        evidenceTier: 'probabilistic',
        confidence: 0.5,
      }),
    ]);
    const history = observations('x', [0.7, 0.7, 0.7, 0.7, 0.7]);
    const updates = await applyDialectic({ record, observationHistory: history });
    expect(updates[0]!.kind).toBe('demoted');
    expect(updates[0]!.newEvidenceTier).toBe('speculative');
  });

  test('speculative section cannot demote further — stays speculative (boundary)', async () => {
    const record = recordWith([
      section({
        slug: 'x',
        heading: 'X',
        predictedResponse: 'p',
        evidenceTier: 'speculative',
        confidence: 0.1,
      }),
    ]);
    const history = observations('x', [0.7, 0.7, 0.7, 0.7, 0.7]);
    const updates = await applyDialectic({ record, observationHistory: history });
    expect(updates[0]!.kind).toBe('none');
    expect(updates[0]!.reason).toMatch(/demotion floor/);
  });
});

describe('applyDialectic — revision path (with critic)', () => {
  test('critic-provided branch proposes a new prediction and resets to probabilistic', async () => {
    const record = recordWith([
      section({
        slug: 'communication-style',
        heading: 'Communication style',
        predictedResponse: 'user prefers terse replies',
        evidenceTier: 'heuristic',
      }),
    ]);
    const history = observations('communication-style', [0.7, 0.7, 0.7, 0.7, 0.7]);

    const critic: DialecticCritic = async (_section, observed) => {
      expect(observed.length).toBe(5);
      return { newPrediction: 'user tolerates verbose replies with context', confidence: 0.65 };
    };

    const updates = await applyDialectic({ record, observationHistory: history, critic });
    expect(updates[0]!.kind).toBe('revised');
    expect(updates[0]!.newPredictedResponse).toBe('user tolerates verbose replies with context');
    expect(updates[0]!.newEvidenceTier).toBe('probabilistic');
    expect(updates[0]!.newConfidence).toBeCloseTo(0.65);
  });

  test('critic confidence is clamped to probabilistic ceiling (0.85)', async () => {
    const record = recordWith([
      section({ slug: 'x', heading: 'X', predictedResponse: 'old', evidenceTier: 'heuristic' }),
    ]);
    const history = observations('x', [0.7, 0.7, 0.7, 0.7, 0.7]);
    const critic: DialecticCritic = async () => ({ newPrediction: 'new', confidence: 0.99 });
    const updates = await applyDialectic({ record, observationHistory: history, critic });
    expect(updates[0]!.newConfidence).toBeLessThanOrEqual(0.85);
  });
});

describe('applyDialectic — flip-to-unknown path (A2)', () => {
  test('error above flip threshold flips section regardless of critic presence', async () => {
    const record = recordWith([
      section({
        slug: 'x',
        heading: 'X',
        predictedResponse: 'p',
        evidenceTier: 'heuristic',
      }),
    ]);
    const history = observations('x', [0.9, 0.95, 1.0, 0.9, 0.95]);

    // Critic MUST NOT be called when flip dominates.
    const critic: DialecticCritic = async () => {
      throw new Error('critic invoked during flip path');
    };

    const updates = await applyDialectic({ record, observationHistory: history, critic });
    expect(updates[0]!.kind).toBe('flipped-to-unknown');
    expect(updates[0]!.newEvidenceTier).toBe('speculative');
    expect(updates[0]!.newConfidence).toBe(0);
    expect(updates[0]!.newPredictedResponse).toBe(UNKNOWN_PREDICTION_TEXT);
  });

  test('flip threshold ordering — revision threshold alone does not flip', async () => {
    const record = recordWith([
      section({ slug: 'x', heading: 'X', predictedResponse: 'p', evidenceTier: 'heuristic' }),
    ]);
    // windowError = 0.7, above revision (0.6) but below flip (0.85).
    const history = observations('x', [0.7, 0.7, 0.7, 0.7, 0.7]);
    const updates = await applyDialectic({ record, observationHistory: history });
    expect(updates[0]!.kind).toBe('demoted');
  });
});

describe('applyDialectic — window behaviour', () => {
  test('only the most recent windowSize observations count', async () => {
    const record = recordWith([
      section({ slug: 'x', heading: 'X', predictedResponse: 'p', evidenceTier: 'heuristic' }),
    ]);
    // 10 observations; first 5 are huge deltas, last 5 are tiny. Window=5
    // should consume only the last 5, so rolling error ≈ 0.1 and the
    // section stays put.
    const early = observations('x', [0.95, 0.95, 0.95, 0.95, 0.95], 1_700_000_000_000);
    const late = observations('x', [0.1, 0.1, 0.1, 0.1, 0.1], 1_700_000_010_000);
    const history = [...early, ...late];
    const updates = await applyDialectic({ record, observationHistory: history, windowSize: 5 });
    expect(updates[0]!.kind).toBe('none');
    expect(updates[0]!.windowSize).toBe(5);
  });

  test('observations for other slugs are ignored', async () => {
    const record = recordWith([section({ slug: 'target', heading: 'Target', predictedResponse: 'p' })]);
    const history = observations('unrelated', [0.9, 0.95, 1.0]);
    const updates = await applyDialectic({ record, observationHistory: history });
    expect(updates[0]!.kind).toBe('none');
    expect(updates[0]!.windowSize).toBe(0);
  });
});

describe('applyDialectic — determinism (A3)', () => {
  test('same inputs produce the same update list', async () => {
    const record = recordWith([
      section({ slug: 'x', heading: 'X', predictedResponse: 'p' }),
      section({ slug: 'y', heading: 'Y', predictedResponse: 'q' }),
    ]);
    const history = [...observations('x', [0.7, 0.7, 0.7, 0.7, 0.7]), ...observations('y', [0.1, 0.1, 0.1, 0.1, 0.1])];

    const run1 = await applyDialectic({ record, observationHistory: history });
    const run2 = await applyDialectic({ record, observationHistory: history });
    expect(run1).toEqual(run2);
  });
});
