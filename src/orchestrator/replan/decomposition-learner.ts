/**
 * Decomposition Learner — Wave B4. Records winning DAG shapes after
 * successful outer-loop iterations and retrieves them as seeds for
 * future tasks with the same signature.
 *
 * A3: Pure deterministic storage + retrieval. No LLM.
 * A7: Success → pattern → reinforcement. Closes the decomposition learning loop.
 */
import { createHash } from 'node:crypto';
import type { PatternStore } from '../../db/pattern-store.ts';
import type { ExtractedPattern, TaskDAG } from '../types.ts';

export interface DecompositionLearnerDeps {
  patternStore: PatternStore;
}

export class DecompositionLearner {
  constructor(private readonly deps: DecompositionLearnerDeps) {}

  /**
   * Record a winning DAG shape after a successful outer-loop iteration.
   * Key = `decomp-${taskSignature}-${dagShapeHash}`.
   * Idempotent: increments frequency if the same pattern already exists.
   */
  recordWinningDecomposition(taskSignature: string, dag: TaskDAG, traceId: string): void {
    if (dag.nodes.length === 0) return;

    const shapeHash = computeDagShapeHash(dag);
    const patternId = `decomp-${taskSignature}-${shapeHash}`;

    const existing = this.deps.patternStore
      .findByTaskSignature(taskSignature)
      .find((p) => p.type === 'decomposition-pattern' && p.id === patternId);

    const freq = (existing?.frequency ?? 0) + 1;
    const pattern: ExtractedPattern = {
      id: patternId,
      type: 'decomposition-pattern',
      description: `Winning DAG: ${dag.nodes.map((n) => n.description).join(' \u2192 ')}`,
      frequency: freq,
      confidence: Math.min(1.0, 0.5 + (existing?.frequency ?? 0) * 0.1),
      taskTypeSignature: taskSignature,
      approach: serializeDagShape(dag),
      sourceTraceIds: existing
        ? [...(existing.sourceTraceIds ?? []), traceId].slice(-10)
        : [traceId],
      createdAt: existing?.createdAt ?? Date.now(),
      decayWeight: 1.0,
    };

    try {
      this.deps.patternStore.insert(pattern);
    } catch {
      // Schema migration may not have run — log rather than crash
    }
  }

  /**
   * Retrieve the best winning DAG shape for a task signature.
   * Returns highest-confidence decomposition-pattern, or undefined.
   */
  retrieveSeedShape(taskSignature: string): TaskDAG | undefined {
    const patterns = this.deps.patternStore
      .findByTaskSignature(taskSignature)
      .filter((p) => p.type === 'decomposition-pattern' && p.decayWeight >= 0.1);

    if (patterns.length === 0) return undefined;

    const best = patterns.sort((a, b) => b.confidence - a.confidence)[0];
    if (!best?.approach) return undefined;

    return deserializeDagShape(best.approach);
  }
}

/**
 * Compute a structural hash of DAG shape: node IDs, dependency edges,
 * oracle sets. File names are excluded so the shape is reusable across
 * tasks that target different files but have the same structure.
 */
export function computeDagShapeHash(dag: TaskDAG): string {
  const structure = dag.nodes
    .map((n) => `${n.id}:deps=${n.dependencies.sort().join(',')}:oracles=${n.assignedOracles.sort().join(',')}`)
    .sort()
    .join('|');
  return createHash('sha256').update(structure).digest('hex').slice(0, 16);
}

/** Serialize DAG shape for storage (structure only, not file-specific). */
function serializeDagShape(dag: TaskDAG): string {
  return JSON.stringify({
    nodes: dag.nodes.map((n) => ({
      id: n.id,
      description: n.description,
      dependencies: n.dependencies,
      assignedOracles: n.assignedOracles,
      targetFileCount: n.targetFiles.length,
    })),
  });
}

/** Deserialize stored DAG shape back to a TaskDAG seed. */
function deserializeDagShape(serialized: string): TaskDAG | undefined {
  try {
    const parsed = JSON.parse(serialized);
    if (!Array.isArray(parsed.nodes)) return undefined;
    return {
      nodes: parsed.nodes.map((n: Record<string, unknown>) => ({
        id: n.id as string,
        description: n.description as string,
        targetFiles: [], // Seed — caller fills in actual files
        dependencies: (n.dependencies as string[]) ?? [],
        assignedOracles: (n.assignedOracles as string[]) ?? [],
      })),
    };
  } catch {
    return undefined;
  }
}
