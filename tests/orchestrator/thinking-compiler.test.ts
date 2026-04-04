import { describe, test, expect } from 'bun:test';
import {
  selectProfile,
  computeThinkingCeiling,
  buildObservationKey,
  compileThinkingPolicy,
  PROFILE_DEFINITIONS,
  DefaultThinkingPolicyCompiler,
} from '../../src/orchestrator/thinking-compiler.ts';
import { computeTaskUncertainty } from '../../src/orchestrator/uncertainty-computer.ts';
import type { TaskUncertaintySignal } from '../../src/orchestrator/thinking-policy.ts';

// ── selectProfile ─────────────────────────────────────────────────────

describe('selectProfile', () => {
  const thresholds = { riskBoundary: 0.35, uncertaintyBoundary: 0.50 };

  test('Profile A: low-risk, low-uncertainty', () => {
    expect(selectProfile(0.1, 0.2, thresholds)).toBe('A');
    expect(selectProfile(0.0, 0.0, thresholds)).toBe('A');
    expect(selectProfile(0.34, 0.49, thresholds)).toBe('A');
  });

  test('Profile B: low-risk, high-uncertainty', () => {
    expect(selectProfile(0.1, 0.8, thresholds)).toBe('B');
    expect(selectProfile(0.0, 0.50, thresholds)).toBe('B');
    expect(selectProfile(0.34, 1.0, thresholds)).toBe('B');
  });

  test('Profile C: high-risk, low-uncertainty', () => {
    expect(selectProfile(0.8, 0.2, thresholds)).toBe('C');
    expect(selectProfile(0.35, 0.0, thresholds)).toBe('C');
    expect(selectProfile(1.0, 0.49, thresholds)).toBe('C');
  });

  test('Profile D: high-risk, high-uncertainty', () => {
    expect(selectProfile(0.8, 0.8, thresholds)).toBe('D');
    expect(selectProfile(0.35, 0.50, thresholds)).toBe('D');
    expect(selectProfile(1.0, 1.0, thresholds)).toBe('D');
  });

  test('exact boundary: risk=0.35, uncertainty=0.50 → D (>=)', () => {
    expect(selectProfile(0.35, 0.50, thresholds)).toBe('D');
  });

  test('gap-free: every (risk, uncertainty) pair yields a valid profile', () => {
    for (let r = 0; r <= 1; r += 0.1) {
      for (let u = 0; u <= 1; u += 0.1) {
        const p = selectProfile(r, u, thresholds);
        expect(['A', 'B', 'C', 'D']).toContain(p);
      }
    }
  });
});

// ── computeThinkingCeiling ────────────────────────────────────────────

describe('computeThinkingCeiling', () => {
  test('cold start (confidence < 0.4) returns undefined', () => {
    expect(computeThinkingCeiling('D', 0.0)).toBeUndefined();
    expect(computeThinkingCeiling('B', 0.39)).toBeUndefined();
  });

  test('Profile A always returns 0 (no thinking budget)', () => {
    expect(computeThinkingCeiling('A', 0.5)).toBe(0);
    expect(computeThinkingCeiling('A', 0.9)).toBe(0);
  });

  test('mid-confidence: ceiling = base * (1 - confidence)', () => {
    // Profile C: baseBudget = 10_000, confidence = 0.6 → ceil(10000 * 0.4) = 4000
    expect(computeThinkingCeiling('C', 0.6, 0.05, () => 1)).toBe(4000);
  });

  test('high-confidence (≥0.85): 10% floor (non-audit)', () => {
    // Profile D: baseBudget = 100_000, rng returns 0.5 (not audit) → ceil(100000 * 0.10) = 10000
    expect(computeThinkingCeiling('D', 0.9, 0.05, () => 0.5)).toBe(10_000);
  });

  test('high-confidence audit sample: full budget', () => {
    // rng returns 0.01 (< 0.05 audit rate) → full budget
    expect(computeThinkingCeiling('D', 0.9, 0.05, () => 0.01)).toBe(100_000);
  });

  test('ceiling never below 10% of base for mastered tasks', () => {
    const ceiling = computeThinkingCeiling('B', 0.95, 0.05, () => 0.99);
    // Profile B baseBudget = 60_000, 10% = 6_000
    expect(ceiling).toBe(6_000);
  });
});

// ── buildObservationKey ───────────────────────────────────────────────

describe('buildObservationKey', () => {
  test('produces deterministic key format', async () => {
    const key = await buildObservationKey('code-modify', []);
    expect(key).toMatch(/^code-modify:[a-f0-9]{16}$/);
  });

  test('same inputs produce same key', async () => {
    const k1 = await buildObservationKey('test-task', []);
    const k2 = await buildObservationKey('test-task', []);
    expect(k1).toBe(k2);
  });

  test('different task types produce different keys', async () => {
    const k1 = await buildObservationKey('task-a', []);
    const k2 = await buildObservationKey('task-b', []);
    expect(k1).not.toBe(k2);
  });
});

// ── computeTaskUncertainty ────────────────────────────────────────────

describe('computeTaskUncertainty', () => {
  test('cold-start basis when priorTraceCount < 3', () => {
    const signal = computeTaskUncertainty({
      taskInput: { targetFiles: ['a.ts'] },
      priorTraceCount: 0,
    });
    expect(signal.basis).toBe('cold-start');
    expect(signal.score).toBeGreaterThan(0);
    expect(signal.score).toBeLessThanOrEqual(1);
  });

  test('novelty-based basis for 3-49 traces', () => {
    const signal = computeTaskUncertainty({
      taskInput: { targetFiles: ['a.ts'] },
      priorTraceCount: 10,
    });
    expect(signal.basis).toBe('novelty-based');
  });

  test('calibrated basis for ≥50 traces', () => {
    const signal = computeTaskUncertainty({
      taskInput: { targetFiles: ['a.ts'] },
      priorTraceCount: 100,
    });
    expect(signal.basis).toBe('calibrated');
  });

  test('more files = higher planComplexity', () => {
    const few = computeTaskUncertainty({
      taskInput: { targetFiles: ['a.ts'] },
      priorTraceCount: 25,
    });
    const many = computeTaskUncertainty({
      taskInput: { targetFiles: Array.from({ length: 15 }, (_, i) => `f${i}.ts`) },
      priorTraceCount: 25,
    });
    expect(many.components.planComplexity).toBeGreaterThan(few.components.planComplexity);
    expect(many.score).toBeGreaterThan(few.score);
  });

  test('more traces = lower score (novelty decay)', () => {
    const novel = computeTaskUncertainty({
      taskInput: { targetFiles: ['a.ts'] },
      priorTraceCount: 0,
    });
    const mastered = computeTaskUncertainty({
      taskInput: { targetFiles: ['a.ts'] },
      priorTraceCount: 100,
    });
    expect(mastered.score).toBeLessThan(novel.score);
  });

  test('score is always within [0, 1]', () => {
    for (const n of [0, 1, 5, 25, 50, 100, 500]) {
      const signal = computeTaskUncertainty({
        taskInput: { targetFiles: Array.from({ length: 30 }, (_, i) => `f${i}.ts`), constraints: Array.from({ length: 10 }, () => 'c') },
        priorTraceCount: n,
      });
      expect(signal.score).toBeGreaterThanOrEqual(0);
      expect(signal.score).toBeLessThanOrEqual(1);
    }
  });
});

// ── compileThinkingPolicy (integration) ──────────────────────────────

describe('compileThinkingPolicy', () => {
  const makeUncertainty = (score: number): TaskUncertaintySignal => ({
    score,
    components: { planComplexity: score * 0.6, priorTraceCount: 0.5 },
    basis: 'cold-start',
  });

  test('low-risk low-uncertainty → Profile A, disabled thinking', async () => {
    const policy = await compileThinkingPolicy({
      taskInput: { id: 't1', targetFiles: [], taskType: 'test', goal: 'test' },
      riskScore: 0.1,
      uncertaintySignal: makeUncertainty(0.2),
      routingLevel: 1,
      taskTypeSignature: 'test-sig',
    });
    expect(policy.profileId).toBe('A');
    expect(policy.thinking.type).toBe('disabled');
    expect(policy.policyBasis).toBe('default');
  });

  test('high-risk high-uncertainty → Profile D, adaptive max', async () => {
    const policy = await compileThinkingPolicy({
      taskInput: { id: 't2', targetFiles: [], taskType: 'test', goal: 'test' },
      riskScore: 0.8,
      uncertaintySignal: makeUncertainty(0.8),
      routingLevel: 3,
      taskTypeSignature: 'complex-sig',
      selfModelConfidence: 0.5,
    });
    expect(policy.profileId).toBe('D');
    expect(policy.thinking.type).toBe('adaptive');
    if (policy.thinking.type === 'adaptive') {
      expect(policy.thinking.effort).toBe('max');
    }
    expect(policy.policyBasis).toBe('calibrated');
    expect(policy.thinkingCeiling).toBeDefined();
  });

  test('observationKey is content-addressed', async () => {
    const policy = await compileThinkingPolicy({
      taskInput: { id: 't3', targetFiles: [], taskType: 'test', goal: 'test' },
      riskScore: 0.5,
      uncertaintySignal: makeUncertainty(0.5),
      routingLevel: 2,
      taskTypeSignature: 'my-sig',
    });
    expect(policy.observationKey).toMatch(/^my-sig:/);
  });

  test('respects custom thresholds', async () => {
    const policy = await compileThinkingPolicy({
      taskInput: { id: 't4', targetFiles: [], taskType: 'test', goal: 'test' },
      riskScore: 0.3,
      uncertaintySignal: makeUncertainty(0.3),
      routingLevel: 1,
      taskTypeSignature: 'sig',
      thresholds: { riskBoundary: 0.2, uncertaintyBoundary: 0.2 },
    });
    // With low thresholds, 0.3/0.3 → both high → Profile D
    expect(policy.profileId).toBe('D');
  });
});

// ── DefaultThinkingPolicyCompiler ────────────────────────────────────

describe('DefaultThinkingPolicyCompiler', () => {
  test('implements ThinkingPolicyCompiler interface', async () => {
    const compiler = new DefaultThinkingPolicyCompiler();
    const policy = await compiler.compile({
      taskInput: { id: 't1', targetFiles: [], taskType: 'test', goal: 'test' },
      riskScore: 0.1,
      uncertaintySignal: { score: 0.1, components: { planComplexity: 0.05, priorTraceCount: 0.1 }, basis: 'cold-start' },
      routingLevel: 0,
      taskTypeSignature: 'test',
    });
    expect(policy.profileId).toBe('A');
  });
});

// ── PROFILE_DEFINITIONS ──────────────────────────────────────────────

describe('PROFILE_DEFINITIONS', () => {
  test('all 4 profiles exist', () => {
    expect(Object.keys(PROFILE_DEFINITIONS)).toEqual(['A', 'B', 'C', 'D']);
  });

  test('Profile A has disabled thinking and 0 budget', () => {
    expect(PROFILE_DEFINITIONS.A.thinking.type).toBe('disabled');
    expect(PROFILE_DEFINITIONS.A.baseBudget).toBe(0);
  });

  test('Profile D has highest budget', () => {
    expect(PROFILE_DEFINITIONS.D.baseBudget).toBeGreaterThan(PROFILE_DEFINITIONS.B.baseBudget);
    expect(PROFILE_DEFINITIONS.D.baseBudget).toBeGreaterThan(PROFILE_DEFINITIONS.C.baseBudget);
  });
});
