/**
 * Behavior tests for the T5 per-task-type readiness gate.
 *
 * Pinned contracts:
 *   - per-task-type evaluator delegates to the global gate's logic
 *   - returned verdict carries the taskType so dashboards can filter
 *   - `evaluateAllTaskTypes` groups flat input correctly and preserves order
 *   - cold-start (insufficient volume) on one type does not block another
 */
import { describe, expect, test } from 'bun:test';
import {
  evaluateAllTaskTypes,
  evaluateThinkingReadinessForTaskType,
  THINKING_READINESS_NONE_BUCKET,
  type ThinkingModeStats,
} from '../../../src/orchestrator/thinking/thinking-readiness-gate.ts';

function s(thinkingMode: string, total: number, successes: number): ThinkingModeStats {
  return {
    thinkingMode,
    total,
    successes,
    failures: total - successes,
    successRate: total === 0 ? 0 : successes / total,
    avgQualityComposite: null,
  };
}

describe('evaluateThinkingReadinessForTaskType', () => {
  test('insufficient volume → blocked with insufficient-volume reason', () => {
    const verdict = evaluateThinkingReadinessForTaskType({
      taskType: 'edit-ts',
      stats: [s(THINKING_READINESS_NONE_BUCKET, 5, 3), s('adaptive:high', 5, 5)],
    });
    expect(verdict.status).toBe('blocked');
    if (verdict.status === 'blocked') expect(verdict.reason).toBe('insufficient-volume');
    expect(verdict.taskType).toBe('edit-ts');
  });

  test('passes gate → ready verdict carries taskType + bestMode + delta', () => {
    const verdict = evaluateThinkingReadinessForTaskType({
      taskType: 'review-md',
      stats: [s(THINKING_READINESS_NONE_BUCKET, 100, 50), s('adaptive:high', 50, 35)],
    });
    expect(verdict.status).toBe('ready');
    if (verdict.status === 'ready') {
      expect(verdict.bestMode).toBe('adaptive:high');
      expect(verdict.successRateDelta).toBeCloseTo(0.2, 5);
    }
    expect(verdict.taskType).toBe('review-md');
  });
});

describe('evaluateAllTaskTypes', () => {
  test('groups flat input by taskType and preserves first-seen order', () => {
    const verdicts = evaluateAllTaskTypes([
      { ...s(THINKING_READINESS_NONE_BUCKET, 100, 50), taskType: 'edit-ts' },
      { ...s('adaptive:high', 50, 35), taskType: 'edit-ts' },
      { ...s(THINKING_READINESS_NONE_BUCKET, 5, 1), taskType: 'review-md' },
      { ...s('adaptive:high', 5, 5), taskType: 'review-md' },
    ]);
    expect([...verdicts.keys()]).toEqual(['edit-ts', 'review-md']);
    expect(verdicts.get('edit-ts')?.status).toBe('ready');
    expect(verdicts.get('review-md')?.status).toBe('blocked');
  });

  test('cold-start in one task type does not block another', () => {
    const verdicts = evaluateAllTaskTypes([
      // edit-ts has 150 traces, ready
      { ...s(THINKING_READINESS_NONE_BUCKET, 100, 50), taskType: 'edit-ts' },
      { ...s('adaptive:high', 50, 35), taskType: 'edit-ts' },
      // refactor has only 20 traces, blocked
      { ...s(THINKING_READINESS_NONE_BUCKET, 10, 5), taskType: 'refactor' },
      { ...s('adaptive:high', 10, 9), taskType: 'refactor' },
    ]);
    expect(verdicts.get('edit-ts')?.status).toBe('ready');
    expect(verdicts.get('refactor')?.status).toBe('blocked');
  });
});
