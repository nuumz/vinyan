import { describe, expect, test } from 'bun:test';
import { buildReplanPrompt, type FailureContext } from '../../../src/orchestrator/replan/replan-prompt.ts';
import type { ClassifiedFailure } from '../../../src/orchestrator/failure-classifier.ts';
import type { PerceptualHierarchy, TaskInput, WorkingMemoryState } from '../../../src/orchestrator/types.ts';

function makeInput(overrides?: Partial<TaskInput>): TaskInput {
  return {
    id: 'task-1',
    goal: 'fix the widget',
    domain: 'code-mutation',
    budget: { maxTokens: 8000, maxRetries: 2 },
    targetFiles: ['src/widget.ts'],
    ...overrides,
  } as TaskInput;
}

function makePerception(): PerceptualHierarchy {
  return {
    dependencyCone: {
      directImportees: ['src/utils.ts'],
      transitiveBlastRadius: 3,
    },
  } as PerceptualHierarchy;
}

function makeMemory(): WorkingMemoryState {
  return {
    failedApproaches: [],
    activeHypotheses: [],
    unresolvedUncertainties: [],
    scopedFacts: [],
  };
}

function makeFailure(overrides?: Partial<FailureContext>): FailureContext {
  return {
    failedApproaches: [],
    goalSatisfaction: { score: 0.3, basis: 'deterministic', blockers: [], passedChecks: [], failedChecks: ['type-check'] },
    previousPlanDescription: 'edit src/widget.ts',
    iteration: 1,
    ...overrides,
  };
}

describe('buildReplanPrompt — structured failures (Wave B)', () => {
  test('classifiedFailures present → prompt contains [FAILURE category=...] blocks', () => {
    const failures: ClassifiedFailure[] = [
      { category: 'type_error', file: 'src/foo.ts', line: 42, message: "TS2339: Property 'bar' does not exist", severity: 'error' },
    ];
    const { userPrompt } = buildReplanPrompt(
      makeInput(),
      makePerception(),
      makeMemory(),
      makeFailure({ classifiedFailures: failures }),
    );

    expect(userPrompt).toContain('[FAILURE category=type_error file=src/foo.ts:42 severity=error]');
    expect(userPrompt).toContain("TS2339: Property 'bar' does not exist");
  });

  test('classifiedFailures present → prompt contains [RECOVERY HINTS]', () => {
    const failures: ClassifiedFailure[] = [
      { category: 'type_error', file: 'src/foo.ts', line: 42, message: 'TS2339', severity: 'error' },
    ];
    const { userPrompt } = buildReplanPrompt(
      makeInput(),
      makePerception(),
      makeMemory(),
      makeFailure({ classifiedFailures: failures }),
    );

    expect(userPrompt).toContain('[RECOVERY HINTS]');
    expect(userPrompt).toContain('Isolate the failing file');
  });

  test('classifiedFailures absent → output identical to prior behavior', () => {
    const withoutFailures = buildReplanPrompt(
      makeInput(),
      makePerception(),
      makeMemory(),
      makeFailure({ classifiedFailures: undefined }),
    );
    const withoutField = buildReplanPrompt(
      makeInput(),
      makePerception(),
      makeMemory(),
      makeFailure(),
    );

    expect(withoutFailures.userPrompt).toBe(withoutField.userPrompt);
    expect(withoutFailures.userPrompt).not.toContain('[FAILURE');
    expect(withoutFailures.userPrompt).not.toContain('[RECOVERY HINTS]');
  });

  test('multiple failure categories → each gets its own [FAILURE] line', () => {
    const failures: ClassifiedFailure[] = [
      { category: 'type_error', file: 'src/a.ts', message: 'TS2339', severity: 'error' },
      { category: 'lint_violation', file: 'src/b.ts', line: 10, message: 'no-unused-vars', severity: 'warning' },
    ];
    const { userPrompt } = buildReplanPrompt(
      makeInput(),
      makePerception(),
      makeMemory(),
      makeFailure({ classifiedFailures: failures }),
    );

    expect(userPrompt).toContain('[FAILURE category=type_error');
    expect(userPrompt).toContain('[FAILURE category=lint_violation');
    // Two different recovery hints
    const hintMatches = userPrompt.match(/\[RECOVERY HINTS\]/g);
    expect(hintMatches?.length).toBe(2);
  });

  test('failure without file omits file location', () => {
    const failures: ClassifiedFailure[] = [
      { category: 'goal_misalignment', message: 'output misaligned', severity: 'warning' },
    ];
    const { userPrompt } = buildReplanPrompt(
      makeInput(),
      makePerception(),
      makeMemory(),
      makeFailure({ classifiedFailures: failures }),
    );

    expect(userPrompt).toContain('[FAILURE category=goal_misalignment severity=warning]');
    expect(userPrompt).not.toContain('file=');
  });

  test('unknown category → no recovery hint for that category', () => {
    const failures: ClassifiedFailure[] = [
      { category: 'unknown', message: 'something broke', severity: 'error' },
    ];
    const { userPrompt } = buildReplanPrompt(
      makeInput(),
      makePerception(),
      makeMemory(),
      makeFailure({ classifiedFailures: failures }),
    );

    expect(userPrompt).toContain('[FAILURE category=unknown');
    expect(userPrompt).not.toContain('[RECOVERY HINTS]');
  });

  test('structured failures appear before failed approaches section', () => {
    const failures: ClassifiedFailure[] = [
      { category: 'type_error', file: 'src/x.ts', message: 'TS2339', severity: 'error' },
    ];
    const memory = makeMemory();
    memory.failedApproaches = [
      { approach: 'try direct edit', oracleVerdict: 'type check failed', timestamp: Date.now() },
    ];
    const { userPrompt } = buildReplanPrompt(
      makeInput(),
      makePerception(),
      memory,
      makeFailure({ classifiedFailures: failures, failedApproaches: memory.failedApproaches }),
    );

    const failureIdx = userPrompt.indexOf('[FAILURE category=');
    const approachIdx = userPrompt.indexOf('DO NOT repeat these failed approaches');
    expect(failureIdx).toBeLessThan(approachIdx);
  });
});
