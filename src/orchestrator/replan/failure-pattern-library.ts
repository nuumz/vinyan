/**
 * Failure Pattern Library — Wave B1. Deterministic lookup table mapping
 * FailureCategory to structural DAG transforms (recovery strategies).
 *
 * A3: Zero LLM. All transforms are pure functions of (DAG, failures) → DAG|null.
 * Returns null when a transform is inapplicable (e.g., no file in failure, DAG
 * shape doesn't support the mutation). The replan engine falls through to LLM
 * when null is returned.
 */
import type { ClassifiedFailure, FailureCategory } from '../../orchestrator/failure-classifier.ts';
import type { TaskDAG } from '../../orchestrator/types.ts';

// ── Types ──────────────────────────────────────────────────────

export interface RecoveryStrategy {
  /** Human-readable description of the recovery action. */
  recoveryAction: string;
  /** Formatted hint for the replan prompt (B2). */
  recoveryHint: string;
  /** Structural DAG mutation. Returns null when inapplicable. */
  dagTransform: (dag: TaskDAG, failures: ClassifiedFailure[]) => TaskDAG | null;
}

export type FailurePatternLibrary = ReadonlyMap<FailureCategory, RecoveryStrategy>;

// ── DAG transforms (pure functions) ────────────────────────────

/**
 * type_error: Isolate the failing file into its own node with a `type` oracle.
 * Splits any node whose targetFiles include the failure's file into two:
 * one for the isolated file (type-checked), one for the rest.
 */
function isolateFileNode(dag: TaskDAG, failures: ClassifiedFailure[]): TaskDAG | null {
  const failingFiles = new Set(failures.filter((f) => f.file).map((f) => f.file!));
  if (failingFiles.size === 0) return null;

  const nodes = [...dag.nodes];
  const newNodes: TaskDAG['nodes'] = [];
  let changed = false;

  for (const node of nodes) {
    const isolated = node.targetFiles.filter((f) => failingFiles.has(f));
    const remaining = node.targetFiles.filter((f) => !failingFiles.has(f));

    if (isolated.length === 0) {
      newNodes.push({ ...node });
      continue;
    }

    changed = true;

    // Isolated file node — dedicated type-check
    const isoId = `${node.id}-type-iso`;
    newNodes.push({
      id: isoId,
      description: `type-check isolation for ${isolated.join(', ')}`,
      targetFiles: isolated,
      dependencies: [...node.dependencies],
      assignedOracles: ['type'],
    });

    if (remaining.length > 0) {
      // Remaining files keep original oracles; depend on the isolated check
      newNodes.push({
        ...node,
        targetFiles: remaining,
        dependencies: [...node.dependencies, isoId],
      });
    }
  }

  if (!changed) return null;
  return { ...dag, nodes: newNodes, isFallback: false };
}

/**
 * test_failure: Prepend a test-expectations node. All existing nodes
 * gain a dependency on this new node, forcing the system to verify
 * test expectations before editing source.
 */
function addTestExpectationsFirst(dag: TaskDAG, failures: ClassifiedFailure[]): TaskDAG | null {
  const testFiles = failures.filter((f) => f.file).map((f) => f.file!);
  const expectNodeId = 'n0-test-expectations';

  // Avoid duplicate if already present
  if (dag.nodes.some((n) => n.id === expectNodeId)) return null;

  const expectNode: TaskDAG['nodes'][number] = {
    id: expectNodeId,
    description: `verify test expectations before implementation${testFiles.length > 0 ? ` (${testFiles.join(', ')})` : ''}`,
    targetFiles: testFiles.length > 0 ? testFiles : [],
    dependencies: [],
    assignedOracles: ['test'],
  };

  const updatedNodes = dag.nodes.map((n) => ({
    ...n,
    dependencies: n.dependencies.includes(expectNodeId) ? [...n.dependencies] : [...n.dependencies, expectNodeId],
  }));

  return { ...dag, nodes: [expectNode, ...updatedNodes], isFallback: false };
}

/**
 * hallucination_file: Replace nodes referencing hallucinated files with
 * a single perception-recheck node. Validates file existence via AST oracle.
 */
function forcePerceptionReassembly(dag: TaskDAG, failures: ClassifiedFailure[]): TaskDAG | null {
  const hallucinatedFiles = new Set(failures.filter((f) => f.file).map((f) => f.file!));
  if (hallucinatedFiles.size === 0) return null;

  const cleanNodes: TaskDAG['nodes'] = [];
  const removedIds = new Set<string>();

  for (const node of dag.nodes) {
    const hasHallucinated = node.targetFiles.some((f) => hallucinatedFiles.has(f));
    if (hasHallucinated) {
      removedIds.add(node.id);
    } else {
      cleanNodes.push({ ...node });
    }
  }

  if (removedIds.size === 0) return null;

  // Perception-recheck node
  const recheckNode: TaskDAG['nodes'][number] = {
    id: 'perception-recheck',
    description: `re-assemble perception for ${[...hallucinatedFiles].join(', ')}`,
    targetFiles: [...hallucinatedFiles],
    dependencies: [],
    assignedOracles: ['ast'],
  };

  // Remove dangling dependencies on removed nodes
  const fixedNodes = cleanNodes.map((n) => ({
    ...n,
    dependencies: n.dependencies.filter((d) => !removedIds.has(d)),
  }));

  return { ...dag, nodes: [recheckNode, ...fixedNodes], isFallback: false };
}

/**
 * goal_misalignment: Split multi-file nodes into one-file-per-node
 * with matching dependencies. Makes each mutation atomic.
 */
function splitIntoAtomicCommits(dag: TaskDAG, _failures: ClassifiedFailure[]): TaskDAG | null {
  const newNodes: TaskDAG['nodes'] = [];
  let changed = false;

  for (const node of dag.nodes) {
    if (node.targetFiles.length <= 1) {
      newNodes.push({ ...node });
      continue;
    }

    changed = true;
    for (let i = 0; i < node.targetFiles.length; i++) {
      const file = node.targetFiles[i]!;
      newNodes.push({
        id: `${node.id}-atomic-${i}`,
        description: `atomic: ${node.description} [${file}]`,
        targetFiles: [file],
        dependencies: [...node.dependencies],
        assignedOracles: [...node.assignedOracles],
      });
    }
  }

  if (!changed) return null;

  // Fix up dependencies: if old node ID was a dependency, replace with all atomic IDs
  const oldToNew = new Map<string, string[]>();
  for (const node of dag.nodes) {
    if (node.targetFiles.length > 1) {
      oldToNew.set(
        node.id,
        node.targetFiles.map((_, i) => `${node.id}-atomic-${i}`),
      );
    }
  }

  const fixedNodes = newNodes.map((n) => {
    const fixedDeps: string[] = [];
    for (const dep of n.dependencies) {
      const replacements = oldToNew.get(dep);
      if (replacements) {
        fixedDeps.push(...replacements);
      } else {
        fixedDeps.push(dep);
      }
    }
    return { ...n, dependencies: fixedDeps };
  });

  return { ...dag, nodes: fixedNodes, isFallback: false };
}

/**
 * lint_violation: Append a lint-fix node after each leaf node (no dependents).
 */
function addPostEditLintFix(dag: TaskDAG, _failures: ClassifiedFailure[]): TaskDAG | null {
  // Find leaf nodes (not depended on by anyone)
  const dependedOn = new Set(dag.nodes.flatMap((n) => n.dependencies));
  const leaves = dag.nodes.filter((n) => !dependedOn.has(n.id) && !n.id.endsWith('-lint-fix'));

  if (leaves.length === 0) return null;

  const lintNodes: TaskDAG['nodes'] = leaves.map((leaf) => ({
    id: `${leaf.id}-lint-fix`,
    description: `run lint --fix on ${leaf.targetFiles.join(', ')}`,
    targetFiles: [...leaf.targetFiles],
    dependencies: [leaf.id],
    assignedOracles: ['lint'],
  }));

  // Avoid duplicate if lint-fix nodes already exist
  const existingIds = new Set(dag.nodes.map((n) => n.id));
  const newLintNodes = lintNodes.filter((n) => !existingIds.has(n.id));
  if (newLintNodes.length === 0) return null;

  return { ...dag, nodes: [...dag.nodes, ...newLintNodes], isFallback: false };
}

// ── Library factory ────────────────────────────────────────────

export function buildFailurePatternLibrary(): FailurePatternLibrary {
  return new Map<FailureCategory, RecoveryStrategy>([
    [
      'type_error',
      {
        recoveryAction: 'isolate-file-node',
        recoveryHint: 'Isolate the failing file into a separate DAG node with type oracle verification',
        dagTransform: isolateFileNode,
      },
    ],
    [
      'test_failure',
      {
        recoveryAction: 'test-expectations-first',
        recoveryHint: 'Add a dependency node to verify test expectations before editing source',
        dagTransform: addTestExpectationsFirst,
      },
    ],
    [
      'hallucination_file',
      {
        recoveryAction: 'perception-reassembly',
        recoveryHint: 'Force perception re-assembly with stricter dep-cone to validate file existence',
        dagTransform: forcePerceptionReassembly,
      },
    ],
    [
      'goal_misalignment',
      {
        recoveryAction: 'atomic-commits',
        recoveryHint: 'Split mutation into smaller atomic commits with per-commit goal check',
        dagTransform: splitIntoAtomicCommits,
      },
    ],
    [
      'lint_violation',
      {
        recoveryAction: 'post-edit-lint-fix',
        recoveryHint: 'Add a post-edit lint-fix node to the DAG after each editing step',
        dagTransform: addPostEditLintFix,
      },
    ],
  ]);
}
