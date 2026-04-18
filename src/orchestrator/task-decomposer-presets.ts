/**
 * Task Decomposer Presets — deterministic DAG templates for common,
 * well-understood task shapes. Presets are picked *before* the LLM-assisted
 * decomposer runs and short-circuit the iteration loop when a match is
 * found. They therefore preserve A3 (deterministic governance) while still
 * giving operators a way to express high-level intent ("research this
 * codebase") without waiting on an LLM round-trip to get a DAG.
 *
 * Book-integration Wave 1.2 (see docs/architecture/book-integration-overview.md):
 *   Adds a *Research Swarm* preset inspired by the Multi-Agent Orchestration
 *   book. Key design choices, with the axiom rationale:
 *
 *     - Fan-out / fan-in, read-only. The swarm spawns N parallel exploration
 *       nodes followed by a single aggregator node. All nodes are read-only
 *       (assignedOracles: ['none-readonly']) so they can never mutate the
 *       workspace. A1 (Epistemic Separation) is reinforced because every
 *       explorer runs in a separate subprocess with its own context — no
 *       shared reasoning memory between them.
 *
 *     - No LLM in the preset selection path. The preset matcher is a pure
 *       keyword + task-type check. A3 holds: the selection is governance,
 *       not generation. The generator (LLM) runs inside the nodes' own
 *       subprocesses, not during decomposition.
 *
 *     - Contract: each explorer must return a structured report with the
 *       same schema (findings, sources, open_questions) so the aggregator
 *       can merge them deterministically. The "ALWAYS-report" discipline
 *       from the book maps directly onto Vinyan's ECP by requiring the
 *       worker to call `attempt_completion` with a non-empty
 *       `proposedContent` — enforced at runtime by the core loop.
 */
import type { PerceptualHierarchy, TaskDAG, TaskInput } from './types.ts';

// ── Public types ────────────────────────────────────────────────────

export type PresetKind = 'research-swarm';

export interface DecomposerPresetMatch {
  /** Which preset fired. */
  kind: PresetKind;
  /** Human-readable label for observability (bus event payload etc.). */
  label: string;
  /** The deterministic DAG produced by the preset. */
  dag: TaskDAG;
}

// ── Research Swarm ──────────────────────────────────────────────────

/**
 * Keywords that reliably indicate an investigation / research / audit goal.
 * Deliberately narrow: false positives are worse than false negatives because
 * a missed preset just falls through to the LLM decomposer (zero-cost
 * degradation), whereas a *wrong* preset would fan out Opus calls on a
 * simple bug-fix task.
 */
const RESEARCH_VERBS = [
  'research',
  'investigate',
  'audit',
  'survey',
  'analyze',
  'analyse',
  'explore',
  'map',
  'catalog',
  'catalogue',
  'review',
] as const;

/**
 * Contract that every research-swarm node's worker must satisfy. Stored as
 * a constant so tests and the design doc can reference the exact string
 * that gets injected into the constraints list.
 */
export const RESEARCH_SWARM_REPORT_CONTRACT = [
  'REPORT_CONTRACT: Return findings as markdown with THREE sections.',
  '  1. "## Findings" — bulleted list; each bullet must cite the file or URL it came from.',
  '  2. "## Sources" — deduplicated list of paths / URLs you actually read.',
  '  3. "## Open Questions" — things you could not verify with the tools available.',
  'If you have nothing to report, still produce the three sections with "(none)" in each.',
  'Do NOT return prose without these section headers — the aggregator parses them.',
].join('\n');

/**
 * Default fan-out when the preset fires. Three explorers balances:
 *   - parallelism (enough perspectives to catch divergent evidence)
 *   - cost (9 Opus calls is the upper bound at L3 — each explorer + one
 *     aggregator)
 *   - signal-to-noise (more than 4 explorers tends to produce duplicated
 *     findings without proportional new signal in our measurements)
 */
export const DEFAULT_RESEARCH_SWARM_FANOUT = 3;

/** Upper bound to keep token budgets predictable. */
const MAX_RESEARCH_SWARM_FANOUT = 5;

export interface ResearchSwarmOptions {
  /**
   * Number of parallel exploration nodes (capped at MAX_RESEARCH_SWARM_FANOUT).
   * Defaults to DEFAULT_RESEARCH_SWARM_FANOUT.
   */
  fanout?: number;
  /**
   * Extra perspective labels — one per explorer. If omitted, the preset
   * auto-assigns "structural / historical / semantic" style perspectives
   * so each explorer's prompt biases toward a different kind of evidence.
   */
  perspectives?: string[];
}

const DEFAULT_PERSPECTIVES = [
  'structural: static code layout, imports, file topology',
  'historical: git log, previous decisions, migration history',
  'semantic: runtime behavior, intent as described in comments / docs',
  'behavioral: tests, fixtures, example usage in the codebase',
  'dependency: transitive callers, public-API consumers, blast radius',
] as const;

/**
 * Build a deterministic research-swarm DAG. Shape:
 *
 *     e1 ─┐
 *     e2 ─┤── aggregate
 *     e3 ─┘
 *
 * Every `eN` is an independent read-only exploration node with a distinct
 * perspective hint. The `aggregate` node depends on all explorers and
 * synthesizes a single report.
 */
export function buildResearchSwarmDAG(
  input: TaskInput,
  perception: PerceptualHierarchy,
  options: ResearchSwarmOptions = {},
): TaskDAG {
  const fanout = Math.max(1, Math.min(options.fanout ?? DEFAULT_RESEARCH_SWARM_FANOUT, MAX_RESEARCH_SWARM_FANOUT));
  const perspectives =
    options.perspectives && options.perspectives.length >= fanout
      ? options.perspectives.slice(0, fanout)
      : DEFAULT_PERSPECTIVES.slice(0, fanout);

  // Read-only oracle tag — the DAG validator treats this as a marker that
  // the node performs no mutations and therefore needs no structural oracle
  // (AST / type / dep). Matches Vinyan's existing convention of keeping
  // "assignedOracles" non-empty for verification coverage.
  const READONLY_ORACLES = ['none-readonly'];

  const blastRadius = [...(input.targetFiles ?? []), ...perception.dependencyCone.directImportees];

  // DAG validator invariant: no scope overlap between nodes (C2). All
  // explorers read from the same codebase — they don't "own" files the
  // way a mutating worker does — so we route the blast-radius files
  // through the aggregator only. Each explorer's subprocess still sees
  // the full targetFiles via its spawned TaskInput (propagated from the
  // parent by core-loop / delegation-router), not via the DAG node.
  const explorerNodes = perspectives.map((perspective, i) => ({
    id: `e${i + 1}`,
    description: `Research (${perspective}): ${input.goal}`,
    targetFiles: [] as string[],
    dependencies: [] as string[],
    assignedOracles: READONLY_ORACLES,
  }));

  const aggregatorNode = {
    id: 'aggregate',
    description: `Synthesize findings from all explorers into a single report for: ${input.goal}`,
    targetFiles: blastRadius,
    dependencies: explorerNodes.map((n) => n.id),
    assignedOracles: READONLY_ORACLES,
  };

  // Wave 5.2: carry the report contract on the DAG's `preamble` field
  // instead of asking the caller to mutate `input.constraints`. The
  // plan phase merges the preamble into a cloned input so the
  // caller's original TaskInput is never mutated. See Phase A §7
  // seam #2 closure.
  return {
    nodes: [...explorerNodes, aggregatorNode],
    preamble: [RESEARCH_SWARM_REPORT_CONTRACT],
  };
}

/**
 * Decide whether the research-swarm preset should fire for a given task.
 * Returns `null` when no preset matches so the caller can fall through to
 * the LLM-assisted decomposer.
 *
 * Rules:
 *   1. `taskType === 'reasoning'` — mutation tasks never get research-swarm.
 *   2. Goal must start with OR contain one of RESEARCH_VERBS within the
 *      first 80 characters (prefix-biased so "fix the bug we found during
 *      our research" does NOT match).
 *   3. Goal must NOT contain strong mutation verbs ("fix", "add", "write",
 *      "implement", "refactor") — those point at codegen, not research.
 */
export function matchDecomposerPreset(input: TaskInput): DecomposerPresetMatch | null {
  if (input.taskType !== 'reasoning') return null;

  const goal = input.goal.toLowerCase();
  const prefix = goal.slice(0, 80);

  const hasResearchVerb = RESEARCH_VERBS.some((v) => prefix.includes(v));
  if (!hasResearchVerb) return null;

  const MUTATION_VERBS = ['fix', 'add ', 'write ', 'implement', 'refactor', 'delete', 'rename'];
  const hasMutationVerb = MUTATION_VERBS.some((v) => goal.includes(v));
  if (hasMutationVerb) return null;

  // The match is decided — DAG construction is deferred to the caller so
  // it can pass the actual PerceptualHierarchy without us needing it here.
  return {
    kind: 'research-swarm',
    label: 'Research Swarm (fan-out 3, read-only)',
    // Placeholder — the caller constructs the DAG via buildResearchSwarmDAG.
    // We still return a stub so the match object is self-describing.
    dag: { nodes: [] },
  };
}
