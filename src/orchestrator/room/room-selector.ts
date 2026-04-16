/**
 * Room Selector — deterministic post-decompose analysis (Option C).
 *
 * Pure function `selectRoomContract(dag, routing, input)` that decides whether
 * an already-validated TaskDAG should execute as a Room rather than the
 * default agentic-loop path. A3: no LLM, no I/O, no randomness — same inputs
 * produce the same output. Invisible to `dag-validator.ts`; the existing gate
 * never checks `collaborationMode` / `roomContract`.
 *
 * Trigger rules (ALL must hold):
 *   1. routing.level >= 2
 *   2. dag.nodes.length >= 3
 *   3. dag is not a fallback and not a composed-skill expansion
 *   4. DAG has fan-out → fan-in topology: ≥2 source nodes (no deps) AND
 *      exactly 1 terminal node (no other node depends on it) AND every
 *      other node is transitively reachable from the terminal via the
 *      dependency edges.
 *   5. aggregate risk (max riskScore across all nodes) >= 0.7
 *
 * When rules pass, the function maps DAG nodes to roles:
 *   - source nodes (no deps)          → `drafter-{i}` (one per source)
 *   - the sink (terminal)             → `integrator`
 *   - an extra review role is added   → `critic` (different-engine check
 *                                        is enforced by RoomDispatcher)
 */
import type { RoutingDecision, TaskDAG, TaskInput } from '../types.ts';
import type { RoleSpec, RoomContract } from './types.ts';

/** Minimum node count for room eligibility. */
const MIN_NODES = 3;
/** Maximum number of drafter roles we generate from the DAG sources. */
const MAX_DRAFTERS = 3;
/** Aggregate-risk threshold below which rooms never fire. */
const RISK_FLOOR = 0.7;
/** Default convergence confidence threshold (matches goal-alignment heuristic cap). */
const DEFAULT_CONVERGENCE_THRESHOLD = 0.7;
/** Default conversation round caps. */
const DEFAULT_MIN_ROUNDS = 1;
const DEFAULT_MAX_ROUNDS = 2;
/** Fraction of the routing token budget reserved for a room (2x the single-worker share
 *  because rooms run multiple participants in sequence). */
const ROOM_BUDGET_MULTIPLIER = 2;

interface TopologyAnalysis {
  sources: TaskDAG['nodes'];
  sink: TaskDAG['nodes'][number];
  allReachable: boolean;
}

/**
 * Analyze the DAG topology to determine whether it forms a fan-out → fan-in
 * shape. Returns null when the shape does not match.
 */
function analyzeTopology(dag: TaskDAG): TopologyAnalysis | null {
  const sources = dag.nodes.filter((n) => n.dependencies.length === 0);
  if (sources.length < 2) return null;

  const referencedIds = new Set<string>();
  for (const node of dag.nodes) {
    for (const depId of node.dependencies) referencedIds.add(depId);
  }
  const sinks = dag.nodes.filter((n) => !referencedIds.has(n.id));
  if (sinks.length !== 1) return null;
  const sink = sinks[0]!;

  // Walk backwards from the sink through the dep edges and collect every
  // node reachable. A diamond/funnel DAG reaches every other node this way.
  const reachable = new Set<string>([sink.id]);
  const byId = new Map(dag.nodes.map((n) => [n.id, n]));
  const queue: string[] = [sink.id];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const node = byId.get(current);
    if (!node) continue;
    for (const depId of node.dependencies) {
      if (!reachable.has(depId)) {
        reachable.add(depId);
        queue.push(depId);
      }
    }
  }
  const allReachable = dag.nodes.every((n) => reachable.has(n.id));

  return { sources, sink, allReachable };
}

/** Largest per-node riskScore across the DAG. Missing scores are treated as 0. */
function aggregateRisk(dag: TaskDAG): number {
  let max = 0;
  for (const node of dag.nodes) {
    const score = node.riskScore ?? 0;
    if (score > max) max = score;
  }
  return max;
}

/** Build the RoleSpec list for a DAG whose topology already passed validation. */
function buildRoles(topology: TopologyAnalysis): RoleSpec[] {
  const drafters: RoleSpec[] = [];
  const drafterCount = Math.min(topology.sources.length, MAX_DRAFTERS);
  for (let i = 0; i < drafterCount; i++) {
    drafters.push({
      name: `drafter-${i}`,
      responsibility: `Produce an initial mutation proposal for node '${topology.sources[i]?.id}'.`,
      writableBlackboardKeys: [`draft/${i}/*`],
      maxTurns: 8,
      canWriteFiles: true,
    });
  }

  const critic: RoleSpec = {
    name: 'critic',
    responsibility: 'Review drafter proposals against the goal. Flag concerns without proposing alternative mutations.',
    writableBlackboardKeys: ['critique/*'],
    maxTurns: 6,
    canWriteFiles: false,
  };

  const integrator: RoleSpec = {
    name: 'integrator',
    responsibility: 'Reconcile drafter proposals with critic feedback; write final mutations and converge the room.',
    writableBlackboardKeys: ['final/*'],
    maxTurns: 8,
    canWriteFiles: true,
  };

  return [...drafters, critic, integrator];
}

/**
 * Decide whether the given DAG should execute as a Room. Returns a fully-formed
 * RoomContract when ALL trigger rules hold; returns null otherwise.
 *
 * Pure — no LLM, no I/O, no wall clock. A3-safe.
 */
export function selectRoomContract(dag: TaskDAG, routing: RoutingDecision, input: TaskInput): RoomContract | null {
  // Rule 1 — routing level floor
  if (routing.level < 2) return null;
  // Rule 2 — node count floor
  if (dag.nodes.length < MIN_NODES) return null;
  // Rule 3 — not a degraded DAG
  if (dag.isFallback || dag.isFromComposedSkill) return null;
  // Rule 4 — fan-out → fan-in topology
  const topology = analyzeTopology(dag);
  if (!topology?.allReachable) return null;
  // Rule 5 — aggregate risk floor
  if (aggregateRisk(dag) < RISK_FLOOR) return null;

  const roles = buildRoles(topology);
  const roomId = `room-${input.id}`;

  return {
    roomId,
    parentTaskId: input.id,
    goal: input.goal,
    roles,
    maxRounds: DEFAULT_MAX_ROUNDS,
    minRounds: DEFAULT_MIN_ROUNDS,
    convergenceThreshold: DEFAULT_CONVERGENCE_THRESHOLD,
    tokenBudget: Math.floor((routing.budgetTokens ?? input.budget.maxTokens) * ROOM_BUDGET_MULTIPLIER),
  };
}

/** Exposed constants for test assertions and downstream reuse. */
export const ROOM_SELECTOR_CONSTANTS = {
  MIN_NODES,
  MAX_DRAFTERS,
  RISK_FLOOR,
  DEFAULT_CONVERGENCE_THRESHOLD,
  DEFAULT_MIN_ROUNDS,
  DEFAULT_MAX_ROUNDS,
  ROOM_BUDGET_MULTIPLIER,
} as const;
