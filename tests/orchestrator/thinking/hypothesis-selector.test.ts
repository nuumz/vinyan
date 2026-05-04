import { describe, expect, test } from 'bun:test';
import type { Hypothesis } from '../../../src/orchestrator/thinking/hypothesis.ts';
import { hypothesisId } from '../../../src/orchestrator/thinking/hypothesis.ts';
import {
  type ApproachHistoryAdapter,
  DefaultHypothesisSelector,
  type PreCheckVerdict,
} from '../../../src/orchestrator/thinking/hypothesis-selector.ts';

type HypothesisOverride = Omit<Partial<Hypothesis>, 'id'> & { id: string };

function makeHypothesis(overrides: HypothesisOverride): Hypothesis {
  return {
    id: hypothesisId(overrides.id),
    engineId: overrides.engineId ?? 'eng-1',
    approachLabel: overrides.approachLabel ?? 'direct',
    content: overrides.content ?? 'hypothesis content',
    diversityFingerprint: overrides.diversityFingerprint ?? 'fp-1',
    tokensUsed: overrides.tokensUsed ?? { input: 100, output: 50 },
    terminationReason: overrides.terminationReason ?? 'completed',
    selfDeclaredConfidence: overrides.selfDeclaredConfidence,
  };
}

describe('DefaultHypothesisSelector — abstain paths (A2)', () => {
  test('empty input → abstain', () => {
    const verdict = new DefaultHypothesisSelector().select({ hypotheses: [] });
    expect(verdict.type).toBe('abstain');
    if (verdict.type === 'abstain') expect(verdict.reason).toContain('no hypotheses');
  });

  test('all hypotheses fail oracle pre-check → abstain (A5)', () => {
    const hs = [makeHypothesis({ id: 'h1' }), makeHypothesis({ id: 'h2' })];
    const preChecks: PreCheckVerdict[] = hs.map((h) => ({
      hypothesisId: h.id,
      passed: false,
      oracle: 'ast',
      reason: 'syntax error',
    }));
    const verdict = new DefaultHypothesisSelector().select({ hypotheses: hs, preChecks });
    expect(verdict.type).toBe('abstain');
    expect(verdict.eliminations.length).toBe(2);
    expect(verdict.eliminations[0]?.rule).toBe('oracle-precheck');
  });
});

describe('DefaultHypothesisSelector — eliminator stage', () => {
  test('oracle-precheck failure removes that hypothesis from contention', () => {
    const winner = makeHypothesis({ id: 'h-good', content: 'a' });
    const loser = makeHypothesis({ id: 'h-bad', content: 'b' });
    const preChecks: PreCheckVerdict[] = [
      { hypothesisId: loser.id, passed: false, oracle: 'type', reason: 'type mismatch' },
    ];
    const verdict = new DefaultHypothesisSelector().select({ hypotheses: [loser, winner], preChecks });
    expect(verdict.type).toBe('select');
    if (verdict.type === 'select') {
      expect(verdict.winner.id).toBe(winner.id);
      expect(verdict.eliminations.find((e) => e.hypothesisId === loser.id)?.reason).toContain('type mismatch');
    }
  });

  test('limit_reached termination eliminates the hypothesis even without pre-check', () => {
    const truncated = makeHypothesis({ id: 'h-cut', terminationReason: 'limit_reached' });
    const complete = makeHypothesis({ id: 'h-ok', terminationReason: 'completed' });
    const verdict = new DefaultHypothesisSelector().select({ hypotheses: [truncated, complete] });
    expect(verdict.type).toBe('select');
    if (verdict.type === 'select') {
      expect(verdict.winner.id).toBe(complete.id);
      expect(verdict.eliminations[0]?.rule).toBe('termination-reason');
    }
  });
});

describe('DefaultHypothesisSelector — Wilson-LB ranking', () => {
  test('higher Wilson score wins when scores differ', () => {
    const hs = [
      makeHypothesis({ id: 'h1', engineId: 'engA', approachLabel: 'direct' }),
      makeHypothesis({ id: 'h2', engineId: 'engB', approachLabel: 'defensive' }),
    ];
    const history: ApproachHistoryAdapter = {
      wilsonLowerBound: (e) => (e === 'engB' ? 0.7 : 0.3),
    };
    const verdict = new DefaultHypothesisSelector().select({ hypotheses: hs, history });
    expect(verdict.type).toBe('select');
    if (verdict.type === 'select') {
      expect(verdict.winner.id).toBe(hypothesisId('h2'));
      expect(verdict.margin).toBeCloseTo(0.4, 5);
    }
  });

  test('observed branch always beats unobserved branch (cold start safe)', () => {
    const hs = [
      makeHypothesis({ id: 'h-cold', engineId: 'engNew' }),
      makeHypothesis({ id: 'h-warm', engineId: 'engOld' }),
    ];
    const history: ApproachHistoryAdapter = {
      wilsonLowerBound: (e) => (e === 'engOld' ? 0.5 : undefined),
    };
    const verdict = new DefaultHypothesisSelector().select({ hypotheses: hs, history });
    expect(verdict.type).toBe('select');
    if (verdict.type === 'select') expect(verdict.winner.id).toBe(hypothesisId('h-warm'));
  });
});

describe('DefaultHypothesisSelector — tiebreakers', () => {
  test('cost tiebreaker chooses the cheaper hypothesis when wilson is tied or absent', () => {
    const cheap = makeHypothesis({ id: 'h-cheap', tokensUsed: { input: 10, output: 5 } });
    const pricey = makeHypothesis({ id: 'h-pricey', tokensUsed: { input: 200, output: 100 } });
    const verdict = new DefaultHypothesisSelector().select({ hypotheses: [pricey, cheap] });
    expect(verdict.type).toBe('select');
    if (verdict.type === 'select') {
      expect(verdict.winner.id).toBe(hypothesisId('h-cheap'));
      expect(verdict.rationale.some((r) => r.includes('cost tiebreaker'))).toBe(true);
    }
  });

  test('stable order tiebreaker when cost is also tied', () => {
    const a = makeHypothesis({ id: 'h-a', tokensUsed: { input: 50, output: 25 } });
    const b = makeHypothesis({ id: 'h-b', tokensUsed: { input: 50, output: 25 } });
    const verdict = new DefaultHypothesisSelector().select({ hypotheses: [a, b] });
    expect(verdict.type).toBe('select');
    if (verdict.type === 'select') expect(verdict.winner.id).toBe(hypothesisId('h-a'));
  });
});

describe('DefaultHypothesisSelector — determinism (A3)', () => {
  test('same inputs produce the same verdict across repeated calls', () => {
    const hs = [
      makeHypothesis({ id: 'h1', engineId: 'eA', approachLabel: 'direct', tokensUsed: { input: 10, output: 5 } }),
      makeHypothesis({ id: 'h2', engineId: 'eB', approachLabel: 'defensive', tokensUsed: { input: 20, output: 10 } }),
      makeHypothesis({ id: 'h3', engineId: 'eC', approachLabel: 'minimal', tokensUsed: { input: 15, output: 5 } }),
    ];
    const history: ApproachHistoryAdapter = {
      wilsonLowerBound: (e) => (({ eA: 0.4, eB: 0.6, eC: 0.4 }) as Record<string, number>)[e],
    };
    const sel = new DefaultHypothesisSelector();
    const v1 = sel.select({ hypotheses: hs, history });
    const v2 = sel.select({ hypotheses: hs, history });
    expect(v1.type).toBe(v2.type);
    if (v1.type === 'select' && v2.type === 'select') {
      expect(v1.winner.id).toBe(v2.winner.id);
      expect(v1.rationale).toEqual(v2.rationale);
    }
  });
});
