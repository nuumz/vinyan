import { describe, expect, test } from 'bun:test';
import {
  computeExecutionLevels,
  detectFileConflicts,
  executeDAG,
  type NodeDispatcher,
  type NodeResult,
} from '../../src/orchestrator/dag-executor.ts';
import type { TaskDAG } from '../../src/orchestrator/types.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function node(id: string, targetFiles: string[], dependencies: string[] = []) {
  return { id, description: `task ${id}`, targetFiles, dependencies, assignedOracles: ['type'] };
}

function makeDispatcher(delay = 0): { dispatcher: NodeDispatcher; callOrder: string[] } {
  const callOrder: string[] = [];
  const dispatcher: NodeDispatcher = async (nodeId, n) => {
    callOrder.push(nodeId);
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    return {
      nodeId,
      mutations: n.targetFiles.map((f) => ({ file: f, content: `content-${nodeId}` })),
      tokensConsumed: 100,
      durationMs: delay,
    };
  };
  return { dispatcher, callOrder };
}

// ---------------------------------------------------------------------------
// detectFileConflicts
// ---------------------------------------------------------------------------

describe('detectFileConflicts', () => {
  test('no conflicts for non-overlapping nodes', () => {
    const dag: TaskDAG = {
      nodes: [node('a', ['x.ts']), node('b', ['y.ts'])],
    };
    expect(detectFileConflicts(dag)).toEqual([]);
  });

  test('detects overlapping files between nodes', () => {
    const dag: TaskDAG = {
      nodes: [node('a', ['shared.ts', 'x.ts']), node('b', ['shared.ts', 'y.ts'])],
    };
    const conflicts = detectFileConflicts(dag);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.file).toBe('shared.ts');
    expect(conflicts[0]!.nodeIds).toEqual(['a', 'b']);
  });

  test('detects multiple conflicting files', () => {
    const dag: TaskDAG = {
      nodes: [node('a', ['f1.ts', 'f2.ts']), node('b', ['f2.ts', 'f3.ts']), node('c', ['f1.ts'])],
    };
    const conflicts = detectFileConflicts(dag);
    expect(conflicts).toHaveLength(2);
    const files = conflicts.map((c) => c.file).sort();
    expect(files).toEqual(['f1.ts', 'f2.ts']);
  });
});

// ---------------------------------------------------------------------------
// computeExecutionLevels
// ---------------------------------------------------------------------------

describe('computeExecutionLevels', () => {
  test('single node = 1 level', () => {
    const dag: TaskDAG = { nodes: [node('a', ['x.ts'])] };
    expect(computeExecutionLevels(dag)).toEqual([['a']]);
  });

  test('independent nodes in same level', () => {
    const dag: TaskDAG = {
      nodes: [node('a', ['x.ts']), node('b', ['y.ts']), node('c', ['z.ts'])],
    };
    const levels = computeExecutionLevels(dag);
    expect(levels).toHaveLength(1);
    expect(levels[0]!.sort()).toEqual(['a', 'b', 'c']);
  });

  test('linear chain = 1 node per level', () => {
    const dag: TaskDAG = {
      nodes: [node('a', ['x.ts']), node('b', ['y.ts'], ['a']), node('c', ['z.ts'], ['b'])],
    };
    expect(computeExecutionLevels(dag)).toEqual([['a'], ['b'], ['c']]);
  });

  test('diamond shape: A→B, A→C, B→D, C→D', () => {
    const dag: TaskDAG = {
      nodes: [
        node('A', ['a.ts']),
        node('B', ['b.ts'], ['A']),
        node('C', ['c.ts'], ['A']),
        node('D', ['d.ts'], ['B', 'C']),
      ],
    };
    const levels = computeExecutionLevels(dag);
    expect(levels).toHaveLength(3);
    expect(levels[0]).toEqual(['A']);
    expect(levels[1]!.sort()).toEqual(['B', 'C']);
    expect(levels[2]).toEqual(['D']);
  });

  test('handles cycle defensively', () => {
    const dag: TaskDAG = {
      nodes: [node('a', ['x.ts'], ['b']), node('b', ['y.ts'], ['a'])],
    };
    const levels = computeExecutionLevels(dag);
    // Both nodes form a cycle — should be placed in a single level
    expect(levels).toHaveLength(1);
    expect(levels[0]!.sort()).toEqual(['a', 'b']);
  });
});

// ---------------------------------------------------------------------------
// executeDAG
// ---------------------------------------------------------------------------

describe('executeDAG', () => {
  test('parallel dispatch for independent nodes', async () => {
    const dag: TaskDAG = {
      nodes: [node('a', ['x.ts']), node('b', ['y.ts'])],
    };
    const { dispatcher, callOrder } = makeDispatcher();
    const result = await executeDAG(dag, dispatcher);

    expect(result.usedParallelExecution).toBe(true);
    expect(result.fileConflicts).toEqual([]);
    expect(result.results).toHaveLength(2);
    expect(result.executionLevels).toHaveLength(1);
  });

  test('sequential fallback when file conflicts detected', async () => {
    const dag: TaskDAG = {
      nodes: [node('a', ['shared.ts']), node('b', ['shared.ts'])],
    };
    const { dispatcher, callOrder } = makeDispatcher();
    const result = await executeDAG(dag, dispatcher);

    expect(result.usedParallelExecution).toBe(false);
    expect(result.fileConflicts).toHaveLength(1);
    // Sequential: call order is deterministic
    expect(callOrder).toEqual(['a', 'b']);
  });

  test('respects dependency order in parallel mode', async () => {
    const dag: TaskDAG = {
      nodes: [node('a', ['x.ts']), node('b', ['y.ts'], ['a'])],
    };
    const { dispatcher, callOrder } = makeDispatcher();
    const result = await executeDAG(dag, dispatcher);

    expect(result.usedParallelExecution).toBe(true);
    expect(result.executionLevels).toEqual([['a'], ['b']]);
    // 'a' must complete before 'b' starts
    expect(callOrder.indexOf('a')).toBeLessThan(callOrder.indexOf('b'));
  });

  test('passes correct node to dispatcher', async () => {
    const dag: TaskDAG = {
      nodes: [node('n1', ['file1.ts']), node('n2', ['file2.ts'])],
    };
    const receivedNodes: Array<{ nodeId: string; files: string[] }> = [];
    const dispatcher: NodeDispatcher = async (nodeId, n) => {
      receivedNodes.push({ nodeId, files: n.targetFiles });
      return { nodeId, mutations: [], tokensConsumed: 0, durationMs: 0 };
    };

    await executeDAG(dag, dispatcher);

    expect(receivedNodes).toHaveLength(2);
    expect(receivedNodes.find((r) => r.nodeId === 'n1')?.files).toEqual(['file1.ts']);
    expect(receivedNodes.find((r) => r.nodeId === 'n2')?.files).toEqual(['file2.ts']);
  });

  test('accumulates total tokens and duration', async () => {
    const dag: TaskDAG = {
      nodes: [node('a', ['x.ts']), node('b', ['y.ts'])],
    };
    const dispatcher: NodeDispatcher = async (nodeId) => ({
      nodeId,
      mutations: [],
      tokensConsumed: 150,
      durationMs: 10,
    });

    const result = await executeDAG(dag, dispatcher);

    expect(result.totalTokens).toBe(300);
    expect(result.totalDurationMs).toBeGreaterThanOrEqual(0);
  });

  test('handles dispatcher errors without crashing', async () => {
    const dag: TaskDAG = {
      nodes: [node('a', ['x.ts']), node('b', ['y.ts'])],
    };
    const dispatcher: NodeDispatcher = async (nodeId) => {
      if (nodeId === 'b') throw new Error('worker failed');
      return { nodeId, mutations: [], tokensConsumed: 100, durationMs: 5 };
    };

    // Promise.all rejects on first error — caller must handle
    await expect(executeDAG(dag, dispatcher)).rejects.toThrow('worker failed');
  });
});
