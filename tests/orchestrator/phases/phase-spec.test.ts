/**
 * Behavior tests for phase-spec.ts
 *
 * Verifies the contract surface — gating rules, spec drafting, approval flow,
 * and projection into enhancedInput. Uses an injected SpecDrafter to make the
 * phase deterministic without an LLM.
 */
import { describe, expect, test } from 'bun:test';
import { createBus } from '../../../src/core/bus.ts';
import { ApprovalGate } from '../../../src/orchestrator/approval-gate.ts';
import {
  executeSpecPhase,
  isSpecPhaseForceDisabled,
  isSpecPhaseForceEnabled,
  projectSpecIntoInput,
  SPEC_PHASE_CONSTRAINTS,
  type SpecDrafter,
  selectSpecVariant,
  shouldRunSpecPhase,
} from '../../../src/orchestrator/phases/phase-spec.ts';
import type { PhaseContext } from '../../../src/orchestrator/phases/types.ts';
import {
  SPEC_ARTIFACT_VERSION,
  type SpecArtifact,
  type SpecArtifactCode,
} from '../../../src/orchestrator/spec/spec-artifact.ts';
import type {
  RoutingDecision,
  SemanticTaskUnderstanding,
  TaskInput,
} from '../../../src/orchestrator/types.ts';

function makeSpec(overrides: Partial<SpecArtifactCode> = {}): SpecArtifactCode {
  return {
    version: SPEC_ARTIFACT_VERSION,
    variant: 'code' as const,
    summary: 'Add cost ledger feature',
    acceptanceCriteria: [
      { id: 'ac-1', description: 'Ledger writes a row per task', testable: true, oracle: 'test' },
      { id: 'ac-2', description: 'Budget enforcement is documented', testable: false, oracle: 'manual' },
    ],
    apiShape: [],
    dataContracts: [],
    edgeCases: [
      { id: 'ec-1', scenario: 'Budget is zero', expected: 'reject task', severity: 'blocker' },
    ],
    openQuestions: [],
    ...overrides,
  };
}

function makeInput(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    id: 'task-spec-test',
    source: 'cli',
    goal: 'Implement a cost ledger',
    taskType: 'feature',
    targetFiles: [],
    constraints: [],
    acceptanceCriteria: [],
    budget: { maxTokens: 10_000, maxRetries: 1, maxDurationMs: 5_000 },
    ...overrides,
  } as TaskInput;
}

function makeUnderstanding(overrides: Partial<SemanticTaskUnderstanding> = {}): SemanticTaskUnderstanding {
  return {
    rawGoal: 'Implement a cost ledger',
    actionVerb: 'implement',
    actionCategory: 'feature',
    frameworkContext: [],
    constraints: [],
    acceptanceCriteria: [],
    expectsMutation: true,
    taskDomain: 'code-mutation',
    taskIntent: 'execute',
    toolRequirement: 'tool-needed',
    resolvedEntities: [],
    understandingDepth: 1,
    verifiedClaims: [],
    understandingFingerprint: 'fingerprint-test',
    ...overrides,
  } as unknown as SemanticTaskUnderstanding;
}

function makeRouting(level: 0 | 1 | 2 | 3 = 1): RoutingDecision {
  return {
    level,
    model: 'sonnet',
    budgetTokens: 8_000,
    latencyBudgetMs: 30_000,
  } as unknown as RoutingDecision;
}

function makeContext(input: TaskInput, drafter?: SpecDrafter, withApprovalGate = false): {
  ctx: PhaseContext;
  bus: ReturnType<typeof createBus>;
  approvalGate?: ApprovalGate;
} {
  const bus = createBus();
  const approvalGate = withApprovalGate ? new ApprovalGate(bus, 5_000) : undefined;
  const ctx: PhaseContext = {
    input,
    startTime: Date.now(),
    workingMemory: { getSnapshot: () => ({}) } as unknown as PhaseContext['workingMemory'],
    explorationFlag: false,
    deps: {
      bus,
      approvalGate,
    } as unknown as PhaseContext['deps'],
  };
  return { ctx, bus, approvalGate };
}

describe('shouldRunSpecPhase — gating rules', () => {
  test('disabled when SPEC_PHASE:off is set in constraints', () => {
    const input = makeInput({ constraints: [SPEC_PHASE_CONSTRAINTS.disable] });
    expect(shouldRunSpecPhase(input, makeUnderstanding(), makeRouting(2))).toBe(false);
  });

  test('enabled when SPEC_PHASE:on is set, even at L0', () => {
    const input = makeInput({ constraints: [SPEC_PHASE_CONSTRAINTS.enable] });
    expect(shouldRunSpecPhase(input, makeUnderstanding(), makeRouting(0))).toBe(true);
  });

  test('disabled at routing level 0 by default', () => {
    expect(shouldRunSpecPhase(makeInput(), makeUnderstanding(), makeRouting(0))).toBe(false);
  });

  test('enabled by default for code-mutation domain at L1+', () => {
    expect(
      shouldRunSpecPhase(makeInput(), makeUnderstanding({ taskDomain: 'code-mutation' }), makeRouting(2)),
    ).toBe(true);
  });

  test('disabled by default for conversational domain at all levels', () => {
    expect(
      shouldRunSpecPhase(makeInput(), makeUnderstanding({ taskDomain: 'conversational' }), makeRouting(2)),
    ).toBe(false);
  });

  test('disabled by default for reasoning domains below L2', () => {
    expect(
      shouldRunSpecPhase(makeInput(), makeUnderstanding({ taskDomain: 'general-reasoning' }), makeRouting(1)),
    ).toBe(false);
  });

  test('off constraint always wins over on constraint', () => {
    const input = makeInput({
      constraints: [SPEC_PHASE_CONSTRAINTS.enable, SPEC_PHASE_CONSTRAINTS.disable],
    });
    expect(shouldRunSpecPhase(input, makeUnderstanding(), makeRouting(2))).toBe(false);
  });
});

describe('isSpecPhaseForceEnabled / isSpecPhaseForceDisabled', () => {
  test('detect SPEC_PHASE:on / SPEC_PHASE:off flags', () => {
    expect(isSpecPhaseForceEnabled([SPEC_PHASE_CONSTRAINTS.enable])).toBe(true);
    expect(isSpecPhaseForceEnabled([])).toBe(false);
    expect(isSpecPhaseForceDisabled([SPEC_PHASE_CONSTRAINTS.disable])).toBe(true);
    expect(isSpecPhaseForceDisabled(undefined)).toBe(false);
  });
});

describe('projectSpecIntoInput', () => {
  test('appends testable criteria + edge-case scenarios to existing input fields', () => {
    const input = makeInput({
      constraints: ['USER:keep changes minimal'],
      acceptanceCriteria: ['Existing criterion stays'],
    });
    const enhanced = projectSpecIntoInput(input, makeSpec());
    expect(enhanced.acceptanceCriteria).toContain('Existing criterion stays');
    expect(enhanced.acceptanceCriteria).toContain('Ledger writes a row per task');
    // Non-testable criteria are NOT projected
    expect(enhanced.acceptanceCriteria).not.toContain('Budget enforcement is documented');
    expect(enhanced.constraints).toContain('USER:keep changes minimal');
    expect(enhanced.constraints).toContain('MUST: Budget is zero → reject task');
  });

  test('does not mutate the caller input', () => {
    const input = makeInput({ constraints: ['original'], acceptanceCriteria: ['original-ac'] });
    const before = JSON.stringify(input);
    projectSpecIntoInput(input, makeSpec());
    expect(JSON.stringify(input)).toBe(before);
  });

  test('dedupes identical strings', () => {
    const input = makeInput({
      acceptanceCriteria: ['Ledger writes a row per task'],
    });
    const enhanced = projectSpecIntoInput(input, makeSpec());
    const occurrences = enhanced.acceptanceCriteria!.filter(
      (c) => c === 'Ledger writes a row per task',
    ).length;
    expect(occurrences).toBe(1);
  });
});

describe('executeSpecPhase — behavior', () => {
  test('skips when gated off', async () => {
    const input = makeInput({ constraints: [SPEC_PHASE_CONSTRAINTS.disable] });
    const { ctx } = makeContext(input);
    const outcome = await executeSpecPhase(ctx, makeRouting(2), makeUnderstanding());
    expect(outcome.action).toBe('continue');
    if (outcome.action === 'continue') {
      expect(outcome.value.skipped).toBe(true);
      expect(outcome.value.reason).toBe('gated-off');
    }
  });

  test('produces an approved spec + enhancedInput when no ApprovalGate is wired', async () => {
    const input = makeInput({ constraints: [SPEC_PHASE_CONSTRAINTS.enable] });
    const drafter: SpecDrafter = { draft: async () => makeSpec() };
    const { ctx, bus } = makeContext(input, drafter);
    let drafted = false;
    let approved = false;
    bus.on('spec:drafted', () => {
      drafted = true;
    });
    bus.on('spec:approved', () => {
      approved = true;
    });
    const outcome = await executeSpecPhase(ctx, makeRouting(1), makeUnderstanding(), { drafter });
    expect(outcome.action).toBe('continue');
    expect(drafted).toBe(true);
    expect(approved).toBe(true);
    if (outcome.action === 'continue') {
      expect(outcome.value.skipped).toBe(false);
      expect(outcome.value.spec?.approvedBy).toBe('auto');
      expect(outcome.value.enhancedInput?.acceptanceCriteria).toContain('Ledger writes a row per task');
    }
  });

  test('approval rejection returns input-required TaskResult and emits spec:rejected', async () => {
    const input = makeInput({ constraints: [SPEC_PHASE_CONSTRAINTS.enable] });
    const drafter: SpecDrafter = { draft: async () => makeSpec() };
    const { ctx, bus, approvalGate } = makeContext(input, drafter, true);
    let rejectedFired = false;
    bus.on('spec:rejected', () => {
      rejectedFired = true;
    });

    // Auto-reject the approval the moment it's requested.
    bus.on('task:approval_required', (payload) => {
      approvalGate!.resolve(payload.taskId, 'rejected');
    });

    const outcome = await executeSpecPhase(ctx, makeRouting(1), makeUnderstanding(), { drafter });
    expect(rejectedFired).toBe(true);
    expect(outcome.action).toBe('return');
    if (outcome.action === 'return') {
      expect(outcome.result.status).toBe('input-required');
      expect((outcome.result.clarificationNeeded ?? []).length).toBeGreaterThanOrEqual(1);
    }
  });

  test('drafter throw degrades to skipped (additive phase, never load-bearing)', async () => {
    const input = makeInput({ constraints: [SPEC_PHASE_CONSTRAINTS.enable] });
    const drafter: SpecDrafter = {
      draft: async () => {
        throw new Error('LLM exploded');
      },
    };
    const { ctx, bus } = makeContext(input, drafter);
    let failureFired = false;
    bus.on('spec:drafting_failed', () => {
      failureFired = true;
    });
    const outcome = await executeSpecPhase(ctx, makeRouting(1), makeUnderstanding(), { drafter });
    expect(failureFired).toBe(true);
    expect(outcome.action).toBe('continue');
    if (outcome.action === 'continue') {
      expect(outcome.value.skipped).toBe(true);
      expect(outcome.value.reason).toBe('drafting-failed');
    }
  });

  test('parallel executeSpecPhase invocations for same taskId share one approval slot', async () => {
    // Regression: two phase invocations entering the gate for the same
    // taskId/default approvalKey must surface ONE user-facing approval
    // (not two), preserve the original requestedAt (no timer reset
    // visible as the approval card's elapsed counter snapping back),
    // and have both waiters settle on a single human resolve. This is
    // the runtime-behavior fix for the duplicate-Spec-approval bug.
    const input = makeInput({ constraints: [SPEC_PHASE_CONSTRAINTS.enable] });
    const drafter: SpecDrafter = { draft: async () => makeSpec() };
    const { ctx, bus, approvalGate } = makeContext(input, drafter, true);

    let requiredCount = 0;
    bus.on('task:approval_required', () => {
      requiredCount++;
    });
    let duplicateCount = 0;
    bus.on('approval:duplicate_request_ignored', () => {
      duplicateCount++;
    });

    // Fire both invocations on the same tick — they race through the
    // drafter's microtask and meet at the gate.
    const p1 = executeSpecPhase(ctx, makeRouting(1), makeUnderstanding(), { drafter });
    const p2 = executeSpecPhase(ctx, makeRouting(1), makeUnderstanding(), { drafter });

    // Flush microtasks until both phase calls have reached the gate.
    // Drafter resolves on the first microtask; the awaitable
    // requestApproval registers the second waiter on the next.
    await new Promise((r) => setTimeout(r, 0));

    expect(approvalGate!.getPendingIds()).toEqual([input.id]);
    expect(approvalGate!.getPending().length).toBe(1);
    expect(requiredCount).toBe(1);
    expect(duplicateCount).toBe(1);

    // Single resolve unblocks both phase invocations — neither hangs.
    expect(approvalGate!.resolve(input.id, 'approved')).toBe(true);
    const [out1, out2] = await Promise.all([p1, p2]);
    expect(out1.action).toBe('continue');
    expect(out2.action).toBe('continue');
  });

  test('approval acceptance stamps approvedBy=human + approvedAt', async () => {
    const input = makeInput({ constraints: [SPEC_PHASE_CONSTRAINTS.enable] });
    const drafter: SpecDrafter = { draft: async () => makeSpec() };
    const { ctx, bus, approvalGate } = makeContext(input, drafter, true);
    bus.on('task:approval_required', (payload) => {
      approvalGate!.resolve(payload.taskId, 'approved');
    });
    const outcome = await executeSpecPhase(ctx, makeRouting(1), makeUnderstanding(), { drafter });
    expect(outcome.action).toBe('continue');
    if (outcome.action === 'continue' && outcome.value.spec) {
      expect(outcome.value.spec.approvedBy).toBe('human');
      expect(outcome.value.spec.approvedAt).toBeGreaterThan(0);
    }
  });
});

// Gap C (2026-04-28): reasoning-variant Spec phase for non-code tasks.
describe('Gap C — reasoning variant', () => {
  test('selectSpecVariant returns "code" for code-mutation, "reasoning" otherwise', () => {
    expect(selectSpecVariant(makeUnderstanding({ taskDomain: 'code-mutation' }))).toBe('code');
    expect(selectSpecVariant(makeUnderstanding({ taskDomain: 'code-reasoning' }))).toBe('reasoning');
    expect(selectSpecVariant(makeUnderstanding({ taskDomain: 'general-reasoning' }))).toBe('reasoning');
    expect(selectSpecVariant(makeUnderstanding({ taskDomain: 'conversational' }))).toBe('reasoning');
  });

  test('shouldRunSpecPhase: code-reasoning at L2+ runs, but L1 does not', () => {
    const reasoning = makeUnderstanding({ taskDomain: 'code-reasoning' });
    expect(shouldRunSpecPhase(makeInput(), reasoning, makeRouting(1))).toBe(false);
    expect(shouldRunSpecPhase(makeInput(), reasoning, makeRouting(2))).toBe(true);
    expect(shouldRunSpecPhase(makeInput(), reasoning, makeRouting(3))).toBe(true);
  });

  test('shouldRunSpecPhase: general-reasoning at L2+ runs', () => {
    const general = makeUnderstanding({ taskDomain: 'general-reasoning' });
    expect(shouldRunSpecPhase(makeInput(), general, makeRouting(2))).toBe(true);
  });

  test('shouldRunSpecPhase: conversational never runs by default', () => {
    const conv = makeUnderstanding({ taskDomain: 'conversational' });
    expect(shouldRunSpecPhase(makeInput(), conv, makeRouting(0))).toBe(false);
    expect(shouldRunSpecPhase(makeInput(), conv, makeRouting(3))).toBe(false);
  });

  test('shouldRunSpecPhase: SPEC_PHASE:on still wins for L0 reasoning', () => {
    const input = makeInput({ constraints: [SPEC_PHASE_CONSTRAINTS.enable] });
    const reasoning = makeUnderstanding({ taskDomain: 'general-reasoning' });
    expect(shouldRunSpecPhase(input, reasoning, makeRouting(0))).toBe(true);
  });

  test('reasoning drafter path produces an approved spec with scope-boundary constraints projected', async () => {
    const reasoningSpec: SpecArtifact = {
      version: SPEC_ARTIFACT_VERSION,
      variant: 'reasoning',
      summary: 'Compare three caching strategies for the order service.',
      acceptanceCriteria: [
        { id: 'ac-1', description: 'Each strategy listed with pros/cons', testable: true, oracle: 'goal-alignment' },
        { id: 'ac-2', description: 'Final recommendation is justified', testable: true, oracle: 'critic' },
      ],
      expectedDeliverables: [
        { kind: 'comparison', audience: 'platform engineer', format: 'table' },
      ],
      scopeBoundaries: {
        outOfScope: ['client-side caching', 'database replication'],
        assumptions: ['p95 read latency target is 50ms'],
      },
      edgeCases: [],
      openQuestions: [],
    };
    const input = makeInput({ constraints: [SPEC_PHASE_CONSTRAINTS.enable] });
    const drafter: SpecDrafter = { draft: async () => reasoningSpec };
    const { ctx, bus } = makeContext(input, drafter);
    let drafted = false;
    bus.on('spec:drafted', () => {
      drafted = true;
    });
    const outcome = await executeSpecPhase(
      ctx,
      makeRouting(2),
      makeUnderstanding({ taskDomain: 'general-reasoning' }),
      { drafter },
    );
    expect(drafted).toBe(true);
    expect(outcome.action).toBe('continue');
    if (outcome.action === 'continue') {
      expect(outcome.value.skipped).toBe(false);
      expect(outcome.value.spec?.variant).toBe('reasoning');
      // Acceptance criteria projected to enhancedInput
      expect(outcome.value.enhancedInput?.acceptanceCriteria).toContain(
        'Each strategy listed with pros/cons',
      );
      // Scope-boundary projection — the topical guardrail from §5 of the design doc
      expect(outcome.value.enhancedInput?.constraints).toContain(
        'MUST: out-of-scope: client-side caching',
      );
      expect(outcome.value.enhancedInput?.constraints).toContain(
        'ASSUME: p95 read latency target is 50ms',
      );
    }
  });
});
