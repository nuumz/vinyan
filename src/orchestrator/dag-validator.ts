/**
 * DAG Validator — 5 machine-checkable criteria for task decomposition.
 *
 * Pure functions, fully testable without LLM.
 * Source of truth: spec/tdd.md §10 (Task Decomposition), arch D7
 */
import type { DagValidationCriteria, TaskDAG } from './types.ts';

/**
 * Validate a TaskDAG against 5 criteria.
 *
 * @param dag - The task decomposition DAG
 * @param blastRadius - Files expected to be affected (from perception)
 */
export function validateDAG(dag: TaskDAG, blastRadius: string[]): DagValidationCriteria {
  const nodes = dag.nodes;
  const nodeIds = new Set(nodes.map((n) => n.id));

  return {
    noOrphans: checkNoOrphans(nodes, nodeIds),
    noScopeOverlap: checkNoScopeOverlap(nodes),
    coverage: checkCoverage(nodes, blastRadius),
    validDependencyOrder: checkValidDependencyOrder(nodes, nodeIds),
    verificationSpecified: checkVerificationSpecified(nodes, nodeIds),
  };
}

export function allCriteriaMet(criteria: DagValidationCriteria): boolean {
  return Object.values(criteria).every(Boolean);
}

export function formatFailures(criteria: DagValidationCriteria): string[] {
  const failures: string[] = [];
  if (!criteria.noOrphans) failures.push('Orphan nodes detected: some nodes are disconnected from the DAG');
  if (!criteria.noScopeOverlap) failures.push('Scope overlap: multiple subtasks target the same file(s)');
  if (!criteria.coverage) failures.push("Coverage gap: subtask targets don't cover all blast radius files");
  if (!criteria.validDependencyOrder)
    failures.push('Invalid dependency order: cycle detected or unknown dependency ID');
  if (!criteria.verificationSpecified) failures.push('Missing verification: leaf nodes must have assigned oracles');
  return failures;
}

// ── Criterion implementations ────────────────────────────────────────

/**
 * C1: No orphans — every node is reachable.
 * A node is an orphan if it has no dependencies AND no other node depends on it,
 * unless it's the only node or a root node in a connected graph.
 */
function checkNoOrphans(nodes: TaskDAG['nodes'], nodeIds: Set<string>): boolean {
  if (nodes.length <= 1) return true;

  // Build adjacency: who depends on whom and who is depended on
  const hasDependents = new Set<string>();
  const hasDependencies = new Set<string>();

  for (const node of nodes) {
    for (const dep of node.dependencies) {
      if (!nodeIds.has(dep)) return false; // unknown dependency = broken graph
      hasDependents.add(dep); // dep has a dependent
      hasDependencies.add(node.id); // this node has dependencies
    }
  }

  // A node is orphan if it neither depends on anything nor is depended upon
  for (const node of nodes) {
    if (!hasDependents.has(node.id) && !hasDependencies.has(node.id)) {
      return false;
    }
  }
  return true;
}

/**
 * C2: No scope overlap — subtask file sets don't intersect.
 */
function checkNoScopeOverlap(nodes: TaskDAG['nodes']): boolean {
  const seen = new Set<string>();
  for (const node of nodes) {
    for (const file of node.targetFiles) {
      if (seen.has(file)) return false;
      seen.add(file);
    }
  }
  return true;
}

/**
 * C3: Coverage — union of subtask targets ⊇ blast radius files.
 */
function checkCoverage(nodes: TaskDAG['nodes'], blastRadius: string[]): boolean {
  if (blastRadius.length === 0) return true;
  const covered = new Set(nodes.flatMap((n) => n.targetFiles));
  return blastRadius.every((f) => covered.has(f));
}

/**
 * C4: Valid dependency order — topological sort succeeds (no cycles).
 * Uses Kahn's algorithm O(V+E).
 */
function checkValidDependencyOrder(nodes: TaskDAG['nodes'], nodeIds: Set<string>): boolean {
  // Check all dependency IDs exist
  for (const node of nodes) {
    for (const dep of node.dependencies) {
      if (!nodeIds.has(dep)) return false;
    }
  }

  // Kahn's algorithm for cycle detection
  const inDegree = new Map<string, number>();
  const adjacency = new Map<string, string[]>();

  for (const node of nodes) {
    inDegree.set(node.id, 0);
    adjacency.set(node.id, []);
  }

  for (const node of nodes) {
    for (const dep of node.dependencies) {
      adjacency.get(dep)?.push(node.id);
      inDegree.set(node.id, (inDegree.get(node.id) ?? 0) + 1);
    }
  }

  const queue: string[] = [];
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id);
  }

  let sorted = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    sorted++;
    for (const neighbor of adjacency.get(current) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1;
      inDegree.set(neighbor, newDegree);
      if (newDegree === 0) queue.push(neighbor);
    }
  }

  return sorted === nodes.length; // All nodes visited → no cycle
}

/**
 * C5: Verification specified — every leaf node has assigned oracles.
 * A leaf node has no dependents (no other node depends on it).
 */
function checkVerificationSpecified(nodes: TaskDAG['nodes'], _nodeIds: Set<string>): boolean {
  const hasDependents = new Set<string>();
  for (const node of nodes) {
    for (const dep of node.dependencies) {
      hasDependents.add(dep);
    }
  }

  for (const node of nodes) {
    if (!hasDependents.has(node.id)) {
      // This is a leaf node — must have oracles
      if (node.assignedOracles.length === 0) return false;
    }
  }
  return true;
}
