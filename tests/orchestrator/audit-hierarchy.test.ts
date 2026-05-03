/**
 * `hierarchyFromInput` — unit tests.
 *
 * This helper is the single mechanism by which every orchestrator-side
 * audit emit site in agent-loop / phase-verify / core-loop /
 * orchestration-boundaries / workflow-executor stamps the id chain
 * (`sessionId`, `subTaskId`, `subAgentId`) on its audit entries. If this
 * helper is wrong, every audit row downstream is wrong.
 *
 * Behavior contract:
 *   - root task (no parentTaskId): `subTaskId` + `subAgentId` are absent.
 *   - sub-task (parentTaskId set): `subTaskId === subAgentId === input.id`.
 *   - sessionId rides through both cases when present on the input.
 *
 * The 1:1 invariant `subAgentId === subTaskId` is centralised here per
 * `agent-vocabulary.subAgentIdFromSubTask` — if that mapping ever
 * decouples, this test (and the helper) is the one place to update.
 */
import { describe, expect, test } from 'bun:test';
import { hierarchyFromInput } from '../../src/orchestrator/observability/audit-hierarchy.ts';
import type { TaskInput } from '../../src/orchestrator/types.ts';

function makeInput(over: Partial<TaskInput> = {}): TaskInput {
  return {
    id: 'task-1',
    source: 'test',
    goal: 'unit smoke',
    targetFiles: [],
    budget: { maxTokens: 1, maxDurationMs: 1, maxRetries: 0 },
    ...over,
  } as unknown as TaskInput;
}

describe('hierarchyFromInput', () => {
  test('root task: omits subTaskId + subAgentId', () => {
    const out = hierarchyFromInput(makeInput({ id: 'root-1' }));
    expect(out.subTaskId).toBeUndefined();
    expect(out.subAgentId).toBeUndefined();
    expect(out.sessionId).toBeUndefined();
  });

  test('root task with sessionId: surfaces sessionId only', () => {
    const out = hierarchyFromInput(makeInput({ id: 'root-1', sessionId: 'sess-1' }));
    expect(out.sessionId).toBe('sess-1');
    expect(out.subTaskId).toBeUndefined();
    expect(out.subAgentId).toBeUndefined();
  });

  test('sub-task: parentTaskId set → subTaskId === subAgentId === input.id', () => {
    const input = makeInput({
      id: 'parent-A-delegate-step1',
      parentTaskId: 'parent-A',
      sessionId: 'sess-A',
    });
    const out = hierarchyFromInput(input);
    expect(out.subTaskId).toBe(input.id);
    expect(out.subAgentId).toBe(input.id);
    expect(out.sessionId).toBe('sess-A');
  });

  test('sub-task without sessionId: still produces subTaskId + subAgentId', () => {
    // Recorder's parentByTask cache fills sessionId post-hoc; the helper
    // does NOT manufacture one.
    const input = makeInput({
      id: 'parent-A-delegate-step1',
      parentTaskId: 'parent-A',
    });
    const out = hierarchyFromInput(input);
    expect(out.sessionId).toBeUndefined();
    expect(out.subTaskId).toBe(input.id);
    expect(out.subAgentId).toBe(input.id);
  });

  test('1:1 invariant — subAgentId always equals subTaskId for delegate inputs', () => {
    for (const variant of [
      'parent-A-delegate-step1',
      'parent-A-wf-step2',
      'parent-A-coding-cli-step3',
      'parent-A-child-1734567890123',
    ]) {
      const out = hierarchyFromInput(makeInput({ id: variant, parentTaskId: 'parent-A' }));
      expect(out.subAgentId).toBe(out.subTaskId!);
    }
  });
});
