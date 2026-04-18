/**
 * Tests for soul-significance-gate — deterministic reflection trigger.
 */
import { describe, expect, test, beforeEach } from 'bun:test';
import {
  isSignificant,
  isRateLimited,
  recordReflection,
  clearRateLimits,
} from '../../../src/orchestrator/agent-context/soul-significance-gate.ts';
import { createEmptyContext } from '../../../src/orchestrator/agent-context/types.ts';

describe('Soul Significance Gate', () => {
  beforeEach(() => {
    clearRateLimits();
  });

  test('failure traces are always significant', () => {
    const ctx = createEmptyContext('worker-1');
    expect(isSignificant({ outcome: 'failure' }, ctx)).toBe(true);
    expect(isSignificant({ outcome: 'escalated' }, ctx)).toBe(true);
  });

  test('routine success is NOT significant', () => {
    const ctx = createEmptyContext('worker-1');
    // Add enough prior episodes for the task type
    for (let i = 0; i < 5; i++) {
      ctx.memory.episodes.push({
        taskId: `task-${i}`,
        taskSignature: 'code:refactor:medium',
        outcome: 'success',
        lesson: 'done',
        filesInvolved: [],
        approachUsed: 'standard',
        timestamp: 1000 + i,
      });
    }
    expect(isSignificant({
      outcome: 'success',
      taskTypeSignature: 'code:refactor:medium',
    }, ctx)).toBe(false);
  });

  test('high prediction error is significant', () => {
    const ctx = createEmptyContext('worker-1');
    // Add enough episodes to make task type "known"
    for (let i = 0; i < 5; i++) {
      ctx.memory.episodes.push({
        taskId: `task-${i}`,
        taskSignature: 'code:test:small',
        outcome: 'success',
        lesson: 'done',
        filesInvolved: [],
        approachUsed: 'standard',
        timestamp: 1000 + i,
      });
    }
    expect(isSignificant({
      outcome: 'success',
      taskTypeSignature: 'code:test:small',
      predictionError: { error: { composite: 0.5 } },
    }, ctx)).toBe(true);
  });

  test('novel task type is significant', () => {
    const ctx = createEmptyContext('worker-1');
    // No prior episodes for this task type
    expect(isSignificant({
      outcome: 'success',
      taskTypeSignature: 'code:new-feature:large',
    }, ctx)).toBe(true);
  });

  test('rate limiting blocks rapid reflections', () => {
    expect(isRateLimited('worker-1')).toBe(false);
    recordReflection('worker-1');
    expect(isRateLimited('worker-1')).toBe(true);
  });

  test('clearRateLimits resets state', () => {
    recordReflection('worker-1');
    expect(isRateLimited('worker-1')).toBe(true);
    clearRateLimits();
    expect(isRateLimited('worker-1')).toBe(false);
  });
});
