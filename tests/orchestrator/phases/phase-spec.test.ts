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
  shouldRunSpecPhase,
  SPEC_PHASE_CONSTRAINTS,
  type SpecDrafter,
} from '../../../src/orchestrator/phases/phase-spec.ts';
import type { PhaseContext } from '../../../src/orchestrator/phases/types.ts';
import {
  SPEC_ARTIFACT_VERSION,
  type SpecArtifact,
} from '../../../src/orchestrator/spec/spec-artifact.ts';
import type {
  RoutingDecision,
  SemanticTaskUnderstanding,
  TaskInput,
} from '../../../src/orchestrator/types.ts';

function makeSpec(overrides: Partial<SpecArtifact> = {}): SpecArtifact {
  return {
    version: SPEC_ARTIFACT_VERSION,
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

  test('disabled by default for code-mutation domain (Phase A — opt-in)', () => {
    // Phase A ships opt-in to avoid regressing existing core-loop tests.
    // Phase B will flip this default; the test documents the current contract.
    expect(
      shouldRunSpecPhase(makeInput(), makeUnderstanding({ taskDomain: 'code-mutation' }), makeRouting(2)),
    ).toBe(false);
  });

  test('disabled by default for non-code-mutation domains', () => {
    expect(
      shouldRunSpecPhase(makeInput(), makeUnderstanding({ taskDomain: 'general-reasoning' }), makeRouting(2)),
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
