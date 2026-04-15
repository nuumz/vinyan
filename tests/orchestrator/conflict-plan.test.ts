/**
 * Book-integration Wave 2.2: merge-conflict pre-computation tests.
 */
import { describe, expect, test } from 'bun:test';
import { computeConflictPlan } from '../../src/orchestrator/concurrent-dispatcher.ts';
import type { TaskInput } from '../../src/orchestrator/types.ts';

function task(id: string, files: string[]): TaskInput {
  return {
    id,
    source: 'cli',
    goal: `task ${id}`,
    taskType: 'code',
    targetFiles: files,
    budget: { maxTokens: 1000, maxRetries: 1, maxDurationMs: 5_000 },
  } as TaskInput;
}

describe('computeConflictPlan', () => {
  test('empty input yields empty plan', () => {
    const plan = computeConflictPlan([]);
    expect(plan.groups).toEqual([]);
    expect(plan.fileFree).toEqual([]);
  });

  test('single file-free task goes into fileFree bucket', () => {
    const plan = computeConflictPlan([task('t1', [])]);
    expect(plan.fileFree).toEqual(['t1']);
    expect(plan.groups).toHaveLength(0);
  });

  test('two non-overlapping tasks form two singleton groups', () => {
    const plan = computeConflictPlan([task('t1', ['a.ts']), task('t2', ['b.ts'])]);
    expect(plan.groups).toHaveLength(2);
    expect(plan.groups.every((g) => g.taskIds.length === 1)).toBe(true);
  });

  test('two tasks sharing a file collapse into one group', () => {
    const plan = computeConflictPlan([task('t1', ['a.ts']), task('t2', ['a.ts', 'b.ts'])]);
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]!.taskIds.sort()).toEqual(['t1', 't2']);
    expect(plan.groups[0]!.files.sort()).toEqual(['a.ts', 'b.ts']);
  });

  test('transitive conflicts collapse via union-find', () => {
    // t1→a, t2→a+b, t3→b+c, t4→c
    // chain: t1-t2-t3-t4 (every adjacent pair shares a file)
    const plan = computeConflictPlan([
      task('t1', ['a.ts']),
      task('t2', ['a.ts', 'b.ts']),
      task('t3', ['b.ts', 'c.ts']),
      task('t4', ['c.ts']),
    ]);
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]!.taskIds.sort()).toEqual(['t1', 't2', 't3', 't4']);
    expect(plan.groups[0]!.files.sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  test('disjoint islands produce separate groups', () => {
    const plan = computeConflictPlan([
      task('t1', ['a.ts']),
      task('t2', ['a.ts']),
      task('t3', ['b.ts']),
      task('t4', ['b.ts']),
    ]);
    expect(plan.groups).toHaveLength(2);
    const groupA = plan.groups.find((g) => g.files.includes('a.ts'))!;
    const groupB = plan.groups.find((g) => g.files.includes('b.ts'))!;
    expect(groupA.taskIds.sort()).toEqual(['t1', 't2']);
    expect(groupB.taskIds.sort()).toEqual(['t3', 't4']);
  });

  test('adjacency records direct conflicts only', () => {
    const plan = computeConflictPlan([task('t1', ['a.ts', 'b.ts']), task('t2', ['b.ts']), task('t3', ['c.ts'])]);
    // t1 and t2 conflict (b.ts); neither conflicts with t3
    expect(plan.adjacency.get('t1')?.has('t2')).toBe(true);
    expect(plan.adjacency.get('t2')?.has('t1')).toBe(true);
    expect(plan.adjacency.get('t1')?.has('t3')).toBe(false);
  });

  test('file-free tasks never appear in any group', () => {
    const plan = computeConflictPlan([task('t1', ['a.ts']), task('t2', []), task('t3', ['a.ts']), task('t4', [])]);
    expect(plan.fileFree.sort()).toEqual(['t2', 't4']);
    for (const g of plan.groups) {
      for (const id of g.taskIds) {
        expect(id).not.toBe('t2');
        expect(id).not.toBe('t4');
      }
    }
  });

  // ── Deep-audit #2: duplicate targetFiles within one task ──────────
  test('Deep-audit #2: duplicate files within one task do not create self-edges', () => {
    const plan = computeConflictPlan([task('t1', ['a.ts', 'a.ts', 'a.ts'])]);
    // adjacency for t1 must not contain t1 itself
    expect(plan.adjacency.get('t1')?.has('t1')).toBe(false);
    // The task should still be in a proper singleton group
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]!.taskIds).toEqual(['t1']);
    // The group's files should be deduped to a single entry
    expect(plan.groups[0]!.files).toEqual(['a.ts']);
  });

  test('Deep-audit #2: dedupe does not break the shared-file conflict detection', () => {
    // t1 has 'a.ts' listed twice; t2 has 'a.ts' once. They should
    // still collapse into the same group.
    const plan = computeConflictPlan([task('t1', ['a.ts', 'a.ts']), task('t2', ['a.ts'])]);
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]!.taskIds.sort()).toEqual(['t1', 't2']);
    // And neither task has a self-edge
    expect(plan.adjacency.get('t1')?.has('t1')).toBe(false);
    expect(plan.adjacency.get('t2')?.has('t2')).toBe(false);
    // They DO have cross-edges
    expect(plan.adjacency.get('t1')?.has('t2')).toBe(true);
    expect(plan.adjacency.get('t2')?.has('t1')).toBe(true);
  });
});
