/**
 * Behavior tests for phase-brainstorm.ts
 *
 * Verifies gating, drafter integration, approval flow, and projection of
 * the chosen candidate into TaskInput.constraints. Uses an injected
 * IdeationDrafter so the phase is deterministic without an LLM.
 */
import { describe, expect, test } from 'bun:test';
import { createBus } from '../../../src/core/bus.ts';
import { ApprovalGate } from '../../../src/orchestrator/approval-gate.ts';
import {
  BRAINSTORM_PHASE_CONSTRAINTS,
  executeBrainstormPhase,
  formatCandidatesForDisplay,
  projectIdeationIntoInput,
  shouldRunBrainstormPhase,
  type IdeationDrafter,
} from '../../../src/orchestrator/phases/phase-brainstorm.ts';
import type { PhaseContext } from '../../../src/orchestrator/phases/types.ts';
import type { IdeationResult } from '../../../src/orchestrator/intent/ideation-types.ts';
import type {
  RoutingDecision,
  SemanticTaskUnderstanding,
  TaskInput,
} from '../../../src/orchestrator/types.ts';

function makeIdeation(overrides: Partial<IdeationResult> = {}): IdeationResult {
  return {
    candidates: [
      {
        id: 'cand-0',
        title: 'Approach A',
        approach: 'Use a single-table-design DynamoDB schema',
        rationale: 'Lowest cost at low scale',
        riskNotes: ['Vendor lock-in'],
        estComplexity: 'medium',
        score: 0.8,
      },
      {
        id: 'cand-1',
        title: 'Approach B',
        approach: 'Use Postgres + JSONB for flexibility',
        rationale: 'SQL ergonomics and migrations are easier',
        riskNotes: [],
        estComplexity: 'small',
        score: 0.6,
      },
    ],
    rankedIds: ['cand-0', 'cand-1'],
    convergenceScore: 0.2,
    ...overrides,
  };
}

function makeInput(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    id: 'task-brainstorm-test',
    source: 'cli',
    goal: 'How should we store user analytics events at scale?',
    taskType: 'reasoning',
    targetFiles: [],
    constraints: [],
    acceptanceCriteria: [],
    budget: { maxTokens: 10_000, maxRetries: 1, maxDurationMs: 5_000 },
    ...overrides,
  } as TaskInput;
}

function makeUnderstanding(overrides: Partial<SemanticTaskUnderstanding> = {}): SemanticTaskUnderstanding {
  return {
    rawGoal: 'How should we store user analytics events at scale?',
    actionVerb: 'design',
    actionCategory: 'investigation',
    frameworkContext: [],
    constraints: [],
    acceptanceCriteria: [],
    expectsMutation: false,
    taskDomain: 'general-reasoning',
    taskIntent: 'inquire',
    toolRequirement: 'none',
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

function makeContext(input: TaskInput, withApprovalGate = false): {
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

describe('shouldRunBrainstormPhase', () => {
  test('off-flag wins over everything', () => {
    const input = makeInput({ constraints: [BRAINSTORM_PHASE_CONSTRAINTS.disable] });
    expect(shouldRunBrainstormPhase(input, makeUnderstanding({ taskIntent: 'ideate' }))).toBe(false);
  });

  test('on-flag forces enable', () => {
    const input = makeInput({
      constraints: [BRAINSTORM_PHASE_CONSTRAINTS.enable],
      goal: 'Add a column to users table',
    });
    expect(shouldRunBrainstormPhase(input, makeUnderstanding({ taskIntent: 'execute' }))).toBe(true);
  });

  test('disabled by default even when taskIntent is ideate (Phase A — opt-in)', () => {
    // Phase A ships opt-in so existing core-loop tests are not impacted.
    // Phase B will flip the default to use the classifier / intent.
    expect(shouldRunBrainstormPhase(makeInput(), makeUnderstanding({ taskIntent: 'ideate' }))).toBe(false);
  });

  test('disabled by default for an open-ended question goal (Phase A — opt-in)', () => {
    expect(
      shouldRunBrainstormPhase(
        makeInput({ goal: 'How should we redesign the auth system for SSO?' }),
        makeUnderstanding(),
      ),
    ).toBe(false);
  });

  test('disabled for routine goals regardless of defaults', () => {
    expect(
      shouldRunBrainstormPhase(
        makeInput({ goal: 'Add a column user_id to the users table' }),
        makeUnderstanding(),
      ),
    ).toBe(false);
  });
});

describe('projectIdeationIntoInput', () => {
  test('returns input unchanged when no candidate is approved', () => {
    const input = makeInput();
    const result = projectIdeationIntoInput(input, makeIdeation());
    expect(result).toBe(input);
  });

  test('appends an APPROACH: constraint when a candidate is approved', () => {
    const input = makeInput();
    const ideation = makeIdeation({ approvedCandidateId: 'cand-1' });
    const result = projectIdeationIntoInput(input, ideation);
    expect(result.constraints?.some((c) => c.startsWith('APPROACH: Approach B'))).toBe(true);
  });

  test('does not duplicate an already-present APPROACH constraint', () => {
    const ideation = makeIdeation({ approvedCandidateId: 'cand-0' });
    const constraint =
      'APPROACH: Approach A — Use a single-table-design DynamoDB schema (risks: Vendor lock-in)';
    const input = makeInput({ constraints: [constraint] });
    const result = projectIdeationIntoInput(input, ideation);
    const occurrences = result.constraints!.filter((c) => c === constraint).length;
    expect(occurrences).toBe(1);
  });
});

describe('formatCandidatesForDisplay', () => {
  test('returns candidates in ranked order with summary fields', () => {
    const ideation = makeIdeation();
    const display = formatCandidatesForDisplay(ideation);
    expect(display.length).toBe(2);
    expect(display[0]?.id).toBe('cand-0');
    expect(display[1]?.id).toBe('cand-1');
    expect(display[0]?.riskCount).toBe(1);
  });
});

describe('executeBrainstormPhase — behavior', () => {
  test('skips when gated off via constraint', async () => {
    const input = makeInput({ constraints: [BRAINSTORM_PHASE_CONSTRAINTS.disable] });
    const { ctx } = makeContext(input);
    const drafter: IdeationDrafter = { draft: async () => makeIdeation() };
    const outcome = await executeBrainstormPhase(ctx, makeRouting(1), makeUnderstanding(), { drafter });
    expect(outcome.action).toBe('continue');
    if (outcome.action === 'continue') {
      expect(outcome.value.skipped).toBe(true);
      expect(outcome.value.reason).toBe('gated-off');
    }
  });

  test('drafts ideation, auto-selects top candidate when no ApprovalGate', async () => {
    const input = makeInput({ constraints: [BRAINSTORM_PHASE_CONSTRAINTS.enable] });
    const { ctx, bus } = makeContext(input);
    let drafted = false;
    let approved = false;
    bus.on('brainstorm:drafted', () => {
      drafted = true;
    });
    bus.on('brainstorm:approved', () => {
      approved = true;
    });
    const drafter: IdeationDrafter = { draft: async () => makeIdeation() };
    const outcome = await executeBrainstormPhase(ctx, makeRouting(1), makeUnderstanding(), { drafter });
    expect(drafted).toBe(true);
    expect(approved).toBe(true);
    expect(outcome.action).toBe('continue');
    if (outcome.action === 'continue') {
      expect(outcome.value.skipped).toBe(false);
      expect(outcome.value.ideation?.approvedCandidateId).toBe('cand-0');
      expect(
        outcome.value.enhancedInput?.constraints?.some((c) => c.startsWith('APPROACH: Approach A')),
      ).toBe(true);
    }
  });

  test('approval rejection returns input-required and emits brainstorm:rejected', async () => {
    const input = makeInput({ constraints: [BRAINSTORM_PHASE_CONSTRAINTS.enable] });
    const { ctx, bus, approvalGate } = makeContext(input, true);
    let rejectedFired = false;
    bus.on('brainstorm:rejected', () => {
      rejectedFired = true;
    });
    bus.on('task:approval_required', (payload) => {
      approvalGate!.resolve(payload.taskId, 'rejected');
    });
    const drafter: IdeationDrafter = { draft: async () => makeIdeation() };
    const outcome = await executeBrainstormPhase(ctx, makeRouting(1), makeUnderstanding(), { drafter });
    expect(rejectedFired).toBe(true);
    expect(outcome.action).toBe('return');
    if (outcome.action === 'return') {
      expect(outcome.result.status).toBe('input-required');
    }
  });

  test('autoSelectTopCandidate option bypasses ApprovalGate', async () => {
    const input = makeInput({ constraints: [BRAINSTORM_PHASE_CONSTRAINTS.enable] });
    const { ctx, approvalGate, bus } = makeContext(input, true);
    let approvalRequested = false;
    bus.on('task:approval_required', () => {
      approvalRequested = true;
      // never resolve — we're testing that autoSelect skips this entirely
    });
    const drafter: IdeationDrafter = { draft: async () => makeIdeation() };
    const outcome = await executeBrainstormPhase(ctx, makeRouting(1), makeUnderstanding(), {
      drafter,
      autoSelectTopCandidate: true,
    });
    expect(approvalRequested).toBe(false);
    expect(approvalGate!.hasPending(input.id)).toBe(false);
    expect(outcome.action).toBe('continue');
  });

  test('drafter throw degrades to skipped (additive phase)', async () => {
    const input = makeInput({ constraints: [BRAINSTORM_PHASE_CONSTRAINTS.enable] });
    const { ctx, bus } = makeContext(input);
    let failed = false;
    bus.on('brainstorm:drafting_failed', () => {
      failed = true;
    });
    const drafter: IdeationDrafter = {
      draft: async () => {
        throw new Error('LLM blew up');
      },
    };
    const outcome = await executeBrainstormPhase(ctx, makeRouting(1), makeUnderstanding(), { drafter });
    expect(failed).toBe(true);
    expect(outcome.action).toBe('continue');
    if (outcome.action === 'continue') {
      expect(outcome.value.skipped).toBe(true);
      expect(outcome.value.reason).toBe('drafting-failed');
    }
  });
});
