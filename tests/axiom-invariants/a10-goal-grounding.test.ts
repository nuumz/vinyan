/**
 * A10 — Goal-and-Time Grounding invariant (proposed).
 *
 * `shouldRunGoalGrounding` returns true under deterministic conditions
 * (routing.level >= 2, riskScore >= threshold, long budget, elapsed
 * time). Pure rule-based check (A3).
 */
import { describe, expect, test } from 'bun:test';
import { shouldRunGoalGrounding } from '../../src/orchestrator/goal-grounding.ts';
import type { RoutingDecision, TaskInput } from '../../src/orchestrator/types.ts';

const baseInput: TaskInput = {
  id: 'a10-task',
  source: 'cli',
  goal: 'test',
  taskType: 'reasoning',
  budget: { maxTokens: 1000, maxDurationMs: 5_000, maxRetries: 0 },
};

const lowRouting: RoutingDecision = {
  level: 0,
  riskScore: 0.1,
  model: null,
  budgetTokens: 0,
  latencyBudgetMs: 100,
};

const highRouting: RoutingDecision = {
  level: 2,
  riskScore: 0.7,
  model: 'mock/balanced',
  budgetTokens: 50_000,
  latencyBudgetMs: 90_000,
};

describe('A10 — Goal-and-Time Grounding', () => {
  test('does not fire on low-risk reflex tasks', () => {
    const fire = shouldRunGoalGrounding({
      input: baseInput,
      routing: lowRouting,
      startedAt: Date.now(),
      now: Date.now(),
    });
    expect(fire).toBe(false);
  });

  test('fires on routing.level >= 2', () => {
    const fire = shouldRunGoalGrounding({
      input: baseInput,
      routing: highRouting,
      startedAt: Date.now(),
      now: Date.now(),
    });
    expect(fire).toBe(true);
  });

  test('fires on high risk score even at low routing level', () => {
    const fire = shouldRunGoalGrounding({
      input: baseInput,
      routing: { ...lowRouting, riskScore: 0.7 },
      startedAt: Date.now(),
      now: Date.now(),
    });
    expect(fire).toBe(true);
  });

  test('fires on long-running budget regardless of routing', () => {
    const longBudget: TaskInput = {
      ...baseInput,
      budget: { ...baseInput.budget, maxDurationMs: 10 * 60_000 },
    };
    const fire = shouldRunGoalGrounding({
      input: longBudget,
      routing: lowRouting,
      startedAt: Date.now(),
      now: Date.now(),
    });
    expect(fire).toBe(true);
  });

  test('fires when elapsed time exceeds threshold', () => {
    const startedAt = Date.now() - 60_000; // 60s elapsed
    const fire = shouldRunGoalGrounding({
      input: baseInput,
      routing: lowRouting,
      startedAt,
      now: Date.now(),
    });
    expect(fire).toBe(true);
  });
});
