/**
 * W3 H3 — intent-resolver schedule pre-classifier.
 *
 * The resolver's existing LLM + deterministic pipeline is unchanged. This
 * suite only tests the add-only `classifyScheduleStrategy()` export:
 *
 *   - Returns `{ strategy: 'schedule', scheduleText }` for inputs that match
 *     the NL scheduling grammar.
 *   - Returns `null` for inputs that do not match, so callers fall through
 *     to the normal pipeline.
 *   - Suppresses a match when the task is a code-mutation (domain or
 *     targetFiles present) — scheduled code edits are NOT H3 scope.
 */
import { describe, expect, test } from 'bun:test';
import { classifyScheduleStrategy } from '../../src/orchestrator/intent-resolver.ts';
import type { SemanticTaskUnderstanding, TaskInput } from '../../src/orchestrator/types.ts';

function input(goal: string, overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    id: 'task-1',
    source: 'cli',
    goal,
    taskType: 'reasoning',
    budget: { maxTokens: 4_000, maxDurationMs: 30_000, maxRetries: 1 },
    ...overrides,
  };
}

function understanding(domain: SemanticTaskUnderstanding['taskDomain']): SemanticTaskUnderstanding {
  // Partial — the classifier only reads `taskDomain`; cast preserves test brevity.
  return {
    rawGoal: 'x',
    actionVerb: 'x',
    actionCategory: 'read',
    frameworkContext: [],
    constraints: [],
    acceptanceCriteria: [],
    expectsMutation: false,
    taskDomain: domain,
    taskIntent: 'execute',
    toolRequirement: 'none',
    resolvedEntities: [],
  } as unknown as SemanticTaskUnderstanding;
}

describe('classifyScheduleStrategy — positive matches', () => {
  test('recognises "every weekday at 9am …"', () => {
    const res = classifyScheduleStrategy(input('every weekday at 9am summarize backlog'));
    expect(res?.strategy).toBe('schedule');
    expect(res?.scheduleText).toBe('every weekday at 9am summarize backlog');
  });

  test('recognises "daily at 20:00 …"', () => {
    const res = classifyScheduleStrategy(input('daily at 20:00 send report'));
    expect(res?.strategy).toBe('schedule');
  });

  test('recognises "every hour …"', () => {
    const res = classifyScheduleStrategy(input('every hour poll incidents'));
    expect(res?.strategy).toBe('schedule');
  });

  test('recognises day-of-week clause "on mondays …"', () => {
    const res = classifyScheduleStrategy(input('on mondays write digest'));
    expect(res?.strategy).toBe('schedule');
  });
});

describe('classifyScheduleStrategy — negative / suppressed matches', () => {
  test('non-scheduling text returns null', () => {
    expect(classifyScheduleStrategy(input('rename foo to bar in the project'))).toBeNull();
  });

  test('code-mutation domain suppresses the match even if pattern hits', () => {
    const res = classifyScheduleStrategy(
      input('every weekday at 9am refactor the helper'),
      understanding('code-mutation'),
    );
    expect(res).toBeNull();
  });

  test('targetFiles presence suppresses the match', () => {
    const res = classifyScheduleStrategy(input('every day at 9am clean up imports', { targetFiles: ['src/foo.ts'] }));
    expect(res).toBeNull();
  });

  test('general-reasoning domain still matches (no suppression)', () => {
    const res = classifyScheduleStrategy(
      input('every weekday at 9am summarize backlog'),
      understanding('general-reasoning'),
    );
    expect(res?.strategy).toBe('schedule');
  });

  test('empty goal returns null', () => {
    expect(classifyScheduleStrategy(input(''))).toBeNull();
  });
});
