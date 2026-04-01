/**
 * Task Decomposer Stub — returns single-node DAG wrapping the input goal.
 *
 * Fallback when no LLM provider is configured. See TaskDecomposerImpl for the full implementation.
 *
 * Source of truth: spec/tdd.md §10 (Task Decomposition), arch D7
 */
import type { TaskDecomposer } from './core-loop.ts';
import type { PerceptualHierarchy, TaskDAG, TaskInput, WorkingMemoryState } from './types.ts';

export class TaskDecomposerStub implements TaskDecomposer {
  async decompose(input: TaskInput, _perception: PerceptualHierarchy, _memory: WorkingMemoryState): Promise<TaskDAG> {
    return {
      nodes: [
        {
          id: 'n1',
          description: input.goal,
          targetFiles: input.targetFiles ?? [],
          dependencies: [],
          assignedOracles: ['type', 'dep'],
        },
      ],
    };
  }
}
