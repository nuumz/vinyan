/**
 * DAG Executor — parallel dispatch with conflict detection.
 *
 * EO Concepts:
 *   #1 Parallel DAG Dispatch — independent nodes execute concurrently via Promise.all.
 *   #4 Baseline Guarantee — file conflict detection forces sequential fallback.
 *
 * Pure orchestration logic, no direct worker/oracle dependencies.
 * Accepts a dispatcher function (dependency injection) for testability.
 */
import type { TaskDAG } from './types.ts';

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export interface NodeResult {
  nodeId: string;
  mutations: Array<{ file: string; content: string; diff?: string; explanation?: string }>;
  tokensConsumed: number;
  durationMs: number;
  error?: string;
}

export interface DAGExecutionResult {
  results: NodeResult[];
  totalTokens: number;
  totalDurationMs: number;
  /** Files touched by multiple nodes — indicates potential conflict. */
  fileConflicts: Array<{ file: string; nodeIds: string[] }>;
  /** Whether parallel execution was used (false = sequential fallback). */
  usedParallelExecution: boolean;
  /** Execution order: each inner array = nodes dispatched concurrently. */
  executionLevels: string[][];
}

/** Node shape extracted from TaskDAG for convenience. */
export type TaskDAGNode = TaskDAG['nodes'][0];

/** Dispatch function signature — caller provides the actual worker dispatch logic. */
export type NodeDispatcher = (nodeId: string, node: TaskDAGNode) => Promise<NodeResult>;

// ---------------------------------------------------------------------------
// Conflict detection (#4 Baseline Guarantee)
// ---------------------------------------------------------------------------

/**
 * Detect file conflicts: files that appear as targets in multiple nodes.
 * If conflicts exist, parallel execution is unsafe.
 */
export function detectFileConflicts(dag: TaskDAG): Array<{ file: string; nodeIds: string[] }> {
  const fileToNodes = new Map<string, string[]>();
  for (const node of dag.nodes) {
    for (const file of node.targetFiles) {
      const existing = fileToNodes.get(file);
      if (existing) {
        existing.push(node.id);
      } else {
        fileToNodes.set(file, [node.id]);
      }
    }
  }
  return Array.from(fileToNodes.entries())
    .filter(([, nodes]) => nodes.length > 1)
    .map(([file, nodeIds]) => ({ file, nodeIds }));
}

// ---------------------------------------------------------------------------
// Topological ordering
// ---------------------------------------------------------------------------

/**
 * Compute topological execution levels — nodes at same level have no inter-dependencies.
 * Level 0 = roots (no deps), Level 1 = depends only on L0, etc.
 *
 * Handles cycles defensively: remaining nodes are placed in a final level.
 */
export function computeExecutionLevels(dag: TaskDAG): string[][] {
  const levels: string[][] = [];
  const placed = new Set<string>();
  const remaining = new Set(dag.nodes.map((n) => n.id));

  while (remaining.size > 0) {
    const currentLevel: string[] = [];
    for (const nodeId of remaining) {
      const node = dag.nodes.find((n) => n.id === nodeId);
      if (!node) continue;
      const depsResolved = node.dependencies.every((d) => placed.has(d));
      if (depsResolved) {
        currentLevel.push(nodeId);
      }
    }

    if (currentLevel.length === 0) {
      // Cycle detected — put remaining nodes in a single level (defensive)
      levels.push([...remaining]);
      break;
    }

    for (const id of currentLevel) {
      placed.add(id);
      remaining.delete(id);
    }
    levels.push(currentLevel);
  }

  return levels;
}

// ---------------------------------------------------------------------------
// DAG execution (#1 Parallel DAG Dispatch)
// ---------------------------------------------------------------------------

/**
 * Execute a TaskDAG with parallel dispatch for independent nodes.
 * Falls back to sequential if file conflicts are detected (#4).
 *
 * @param dag - The decomposed task DAG
 * @param dispatcher - Function that executes a single node (injected by caller)
 */
export async function executeDAG(dag: TaskDAG, dispatcher: NodeDispatcher): Promise<DAGExecutionResult> {
  const startTime = performance.now();
  const results: NodeResult[] = [];

  // #4: Detect file conflicts — if any exist, force sequential execution
  const conflicts = detectFileConflicts(dag);
  const levels = computeExecutionLevels(dag);
  const useParallel = conflicts.length === 0;

  if (useParallel) {
    // Parallel: dispatch all nodes in the same level concurrently
    for (const level of levels) {
      const levelResults = await Promise.all(
        level.map((nodeId) => {
          const node = dag.nodes.find((n) => n.id === nodeId);
          if (!node) return Promise.resolve({ nodeId, mutations: [], tokensConsumed: 0, durationMs: 0, error: 'Node not found' });
          return dispatcher(nodeId, node);
        }),
      );
      results.push(...levelResults);
    }
  } else {
    // Sequential fallback: one node at a time in topological order
    for (const level of levels) {
      for (const nodeId of level) {
          const node = dag.nodes.find((n) => n.id === nodeId);
          if (!node) continue;
        const result = await dispatcher(nodeId, node);
        results.push(result);
      }
    }
  }

  return {
    results,
    totalTokens: results.reduce((sum, r) => sum + r.tokensConsumed, 0),
    totalDurationMs: Math.round(performance.now() - startTime),
    fileConflicts: conflicts,
    usedParallelExecution: useParallel,
    executionLevels: levels,
  };
}
