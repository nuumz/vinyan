/**
 * Book-integration Wave 2.1: Architecture Debate Mode tests.
 */
import { describe, expect, test } from 'bun:test';
import type { CriticEngine, CriticResult, WorkerProposal } from '../../../src/orchestrator/critic/critic-engine.ts';
import {
  ArchitectureDebateCritic,
  DebateRouterCritic,
  parseDebateOverride,
  shouldDebate,
} from '../../../src/orchestrator/critic/debate-mode.ts';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponse,
  PerceptualHierarchy,
  TaskInput,
} from '../../../src/orchestrator/types.ts';

// ── Test helpers ─────────────────────────────────────────────────────

function fakeProvider(responses: string[]): LLMProvider {
  let i = 0;
  return {
    id: `fake-${Math.random().toString(36).slice(2, 8)}`,
    tier: 'balanced',
    generate: async (_req: LLMRequest): Promise<LLMResponse> => ({
      content: responses[i++] ?? '',
      tokensUsed: { input: 10, output: 5 },
      toolCalls: [],
      model: 'mock',
      stopReason: 'end_turn' as const,
    }),
  };
}

const task: TaskInput = {
  id: 'task-1',
  source: 'cli',
  goal: 'ship a new feature',
  taskType: 'code',
  targetFiles: ['src/x.ts'],
  budget: { maxTokens: 10_000, maxDurationMs: 5_000, maxRetries: 1 },
};

const perception: PerceptualHierarchy = {
  taskTarget: { file: 'src/x.ts', description: 'add feature' },
  dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
  diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
  verifiedFacts: [],
  runtime: { nodeVersion: 'v20', os: 'darwin', availableTools: [] },
};

const proposal: WorkerProposal = {
  mutations: [{ file: 'src/x.ts', content: 'export function x() {}', explanation: 'add stub' }],
  approach: 'minimal implementation',
};

// ── shouldDebate ─────────────────────────────────────────────────────

describe('shouldDebate trigger rule', () => {
  test('returns false when risk below threshold', () => {
    expect(shouldDebate({ riskScore: 0.5 })).toBe(false);
  });

  test('returns true when risk at threshold', () => {
    expect(shouldDebate({ riskScore: 0.7 })).toBe(true);
  });

  test('manual force overrides low risk', () => {
    expect(shouldDebate({ riskScore: 0.1, manualOverride: 'force' })).toBe(true);
  });

  test('manual skip overrides high risk', () => {
    expect(shouldDebate({ riskScore: 0.99, manualOverride: 'skip' })).toBe(false);
  });

  test('custom threshold', () => {
    expect(shouldDebate({ riskScore: 0.5, threshold: 0.4 })).toBe(true);
    expect(shouldDebate({ riskScore: 0.3, threshold: 0.4 })).toBe(false);
  });
});

describe('parseDebateOverride', () => {
  test('recognizes force', () => {
    expect(parseDebateOverride(['DEBATE:force'])).toBe('force');
  });

  test('recognizes skip', () => {
    expect(parseDebateOverride(['DEBATE:skip'])).toBe('skip');
  });

  test('returns undefined for empty constraints', () => {
    expect(parseDebateOverride()).toBeUndefined();
    expect(parseDebateOverride([])).toBeUndefined();
  });

  test('ignores unrelated constraints', () => {
    expect(parseDebateOverride(['MIN_ROUTING_LEVEL:2', 'something else'])).toBeUndefined();
  });
});

// ── ArchitectureDebateCritic ─────────────────────────────────────────

describe('ArchitectureDebateCritic — 3-seat debate', () => {
  test('approves when architect JSON has zero unresolved attacks', async () => {
    const advocate = fakeProvider(['- proposal is complete\n- matches goal\n- covers edge cases']);
    const counter = fakeProvider(['- nit: missing comment\n- nit: could rename']);
    const architect = fakeProvider([
      JSON.stringify({
        approved: true,
        reason: 'proposal is sound, only nits raised',
        unresolved_attacks: [],
        key_strengths: ['complete', 'matches goal'],
      }),
    ]);

    const critic = new ArchitectureDebateCritic({ advocate, counter, architect });
    const result = await critic.review(proposal, task, perception);

    expect(result.approved).toBe(true);
    expect(result.rounds).toHaveLength(3);
    expect(result.rounds.map((r) => r.seat)).toEqual(['advocate', 'counter', 'architect']);
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  test('rejects when any blocking attack survives', async () => {
    const advocate = fakeProvider(['- good']);
    const counter = fakeProvider(['- blocking: corrupts DB on retry']);
    const architect = fakeProvider([
      JSON.stringify({
        approved: false,
        reason: 'critical DB corruption risk',
        unresolved_attacks: ['blocking: corrupts DB on retry'],
        key_strengths: ['good'],
      }),
    ]);

    const critic = new ArchitectureDebateCritic({ advocate, counter, architect });
    const result = await critic.review(proposal, task, perception);

    expect(result.approved).toBe(false);
    const blockerAspect = result.aspects.find((a) => a.name === 'counter_blockers');
    expect(blockerAspect?.passed).toBe(false);
  });

  test('fail-closes when architect returns non-JSON', async () => {
    const advocate = fakeProvider(['- good']);
    const counter = fakeProvider(['- ok']);
    const architect = fakeProvider(['definitely not json']);

    const critic = new ArchitectureDebateCritic({ advocate, counter, architect });
    const result = await critic.review(proposal, task, perception);

    expect(result.approved).toBe(false);
    expect(result.reason).toContain('parsed');
  });

  test('fail-closes when any provider throws', async () => {
    const advocate: LLMProvider = {
      id: 'advocate-fail',
      tier: 'balanced',
      generate: async () => {
        throw new Error('LLM down');
      },
    };
    const counter = fakeProvider(['- ok']);
    const architect = fakeProvider(['{}']);

    const critic = new ArchitectureDebateCritic({ advocate, counter, architect });
    const result = await critic.review(proposal, task, perception);
    expect(result.approved).toBe(false);
    expect(result.reason).toContain('advocate call failed');
  });
});

// ── DebateRouterCritic ───────────────────────────────────────────────

describe('DebateRouterCritic — selection rule', () => {
  test('routes to baseline when no risk and no override', async () => {
    const baseline = { calls: 0 } as { calls: number };
    const baselineCritic: CriticEngine = {
      review: async () => {
        baseline.calls++;
        return {
          approved: true,
          confidence: 1,
          aspects: [],
          verdicts: {},
          tokensUsed: { input: 0, output: 0 },
          reason: 'baseline',
        };
      },
    };
    const debate = { calls: 0 } as { calls: number };
    const debateCritic: CriticEngine = {
      review: async () => {
        debate.calls++;
        return {
          approved: true,
          confidence: 1,
          aspects: [],
          verdicts: {},
          tokensUsed: { input: 0, output: 0 },
          reason: 'debate',
        };
      },
    };

    const router = new DebateRouterCritic(baselineCritic, debateCritic);
    const result = await router.review(proposal, task, perception);
    expect(result.reason).toBe('baseline');
    expect(baseline.calls).toBe(1);
    expect(debate.calls).toBe(0);
  });

  test('routes to debate when DEBATE:force in constraints', async () => {
    const baselineCritic: CriticEngine = {
      review: async () => ({
        approved: true,
        confidence: 1,
        aspects: [],
        verdicts: {},
        tokensUsed: { input: 0, output: 0 },
        reason: 'baseline',
      }),
    };
    const debateCritic: CriticEngine = {
      review: async () => ({
        approved: true,
        confidence: 1,
        aspects: [],
        verdicts: {},
        tokensUsed: { input: 0, output: 0 },
        reason: 'debate',
      }),
    };

    const router = new DebateRouterCritic(baselineCritic, debateCritic);
    const taskWithForce = { ...task, constraints: ['DEBATE:force'] };
    const result = await router.review(proposal, taskWithForce, perception);
    expect(result.reason).toBe('debate');
  });

  test('routes to debate when riskScore ≥ threshold (via CriticContext)', async () => {
    // Wave 5.1: riskScore is now passed via the typed CriticContext
    // argument, not via an ad-hoc cast on the task object.
    const baselineCritic: CriticEngine = {
      review: async () => ({
        approved: true,
        confidence: 1,
        aspects: [],
        verdicts: {},
        tokensUsed: { input: 0, output: 0 },
        reason: 'baseline',
      }),
    };
    const debateCritic: CriticEngine = {
      review: async () => ({
        approved: true,
        confidence: 1,
        aspects: [],
        verdicts: {},
        tokensUsed: { input: 0, output: 0 },
        reason: 'debate',
      }),
    };
    const router = new DebateRouterCritic(baselineCritic, debateCritic);
    const result = await router.review(proposal, task, perception, undefined, {
      riskScore: 0.85,
      routingLevel: 3,
    });
    expect(result.reason).toBe('debate');
  });
});

// ── Wave 5: critic:debate_fired observability event ─────────────────

describe('DebateRouterCritic — Wave 5 observability', () => {
  const baseline: CriticEngine = {
    review: async () => ({
      approved: true,
      confidence: 1,
      aspects: [],
      verdicts: {},
      tokensUsed: { input: 0, output: 0 },
      reason: 'baseline',
    }),
  };
  const debate: CriticEngine = {
    review: async () => ({
      approved: true,
      confidence: 1,
      aspects: [],
      verdicts: {},
      tokensUsed: { input: 0, output: 0 },
      reason: 'debate',
    }),
  };

  test('emits critic:debate_fired when risk threshold triggers debate', async () => {
    const { createBus } = await import('../../../src/core/bus.ts');
    const bus = createBus();
    const events: Array<{ taskId: string; trigger: string; riskScore?: number; routingLevel?: number }> = [];
    bus.on('critic:debate_fired', (e) => events.push(e));

    const router = new DebateRouterCritic(baseline, debate, { bus });
    await router.review(proposal, task, perception, undefined, {
      riskScore: 0.9,
      routingLevel: 3,
    });

    expect(events).toHaveLength(1);
    expect(events[0]!.taskId).toBe(task.id);
    expect(events[0]!.trigger).toBe('risk-threshold');
    expect(events[0]!.riskScore).toBe(0.9);
    expect(events[0]!.routingLevel).toBe(3);
  });

  test('emits critic:debate_fired with trigger=force on DEBATE:force constraint', async () => {
    const { createBus } = await import('../../../src/core/bus.ts');
    const bus = createBus();
    const events: Array<{ trigger: string }> = [];
    bus.on('critic:debate_fired', (e) => events.push(e));

    const router = new DebateRouterCritic(baseline, debate, { bus });
    const forced = { ...task, constraints: ['DEBATE:force'] };
    await router.review(proposal, forced, perception);

    expect(events).toHaveLength(1);
    expect(events[0]!.trigger).toBe('force');
  });

  test('does NOT emit critic:debate_fired when baseline is picked', async () => {
    const { createBus } = await import('../../../src/core/bus.ts');
    const bus = createBus();
    const events: unknown[] = [];
    bus.on('critic:debate_fired', (e) => events.push(e));

    const router = new DebateRouterCritic(baseline, debate, { bus });
    // No risk context and no manual override → baseline wins, no event
    await router.review(proposal, task, perception);

    expect(events).toHaveLength(0);
  });

  test('router works silently when no bus is provided', async () => {
    // Regression guard: the bus is optional; the router must not throw
    // when it's absent.
    const router = new DebateRouterCritic(baseline, debate);
    const result = await router.review(proposal, task, perception, undefined, {
      riskScore: 0.9,
    });
    expect(result.reason).toBe('debate');
  });
});
