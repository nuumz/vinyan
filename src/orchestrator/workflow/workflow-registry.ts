/**
 * Workflow Registry — Wave 6. Replaces the hard-coded 4-strategy `if` chain
 * in core-loop.ts with an extensible registry pattern.
 *
 * Wave 6 MVP ships the registry + default metadata for the 4 built-in
 * strategies. Wiring the core-loop to dispatch THROUGH the registry is
 * intentionally deferred — this module is shippable and tested on its own.
 *
 * Design constraint: the registry only holds metadata + optional execute
 * function references. Actual orchestrator behavior (intent routing, routing
 * floor enforcement, agentic-workflow goal rewriting) stays in core-loop.ts
 * until the full refactor lands. Callers can query the registry to enumerate
 * available strategies, look up metadata, or check requirements.
 *
 * A3: registry lookup is deterministic (pure Map.get). No LLM in selection.
 * A1: handlers are separate modules from the intent classifier — adding new
 *     handlers doesn't require touching the classifier prompt.
 */

export type RoutingFloor = 0 | 1 | 2 | 3;

export interface WorkflowMetadata {
  /** Strategy name matching IntentResolution.strategy values. */
  strategy: string;
  /** Short human-readable description shown in dashboards / logs. */
  description: string;
  /** True when the handler needs tool access (forces routing floor). */
  requiresTools: boolean;
  /** Minimum routing level the handler requires, if any. */
  routingFloor?: RoutingFloor;
  /** True when handler short-circuits the 6-phase pipeline. */
  shortCircuits: boolean;
  /** True when the handler is a built-in (shipped with Vinyan). */
  builtIn: boolean;
}

/** Default metadata for the 4 strategies currently hard-coded in core-loop.ts. */
export const BUILT_IN_WORKFLOWS: WorkflowMetadata[] = [
  {
    strategy: 'conversational',
    description: 'Direct LLM answer for questions/greetings; skips the 6-phase pipeline.',
    requiresTools: false,
    routingFloor: 0,
    shortCircuits: true,
    builtIn: true,
  },
  {
    strategy: 'direct-tool',
    description: 'Single deterministic tool call (e.g. shell_exec for open -a); skips pipeline.',
    requiresTools: true,
    routingFloor: 2,
    shortCircuits: true,
    builtIn: true,
  },
  {
    strategy: 'agentic-workflow',
    description: 'Multi-step tasks needing planning; rewrites goal and enters full pipeline.',
    requiresTools: true,
    routingFloor: 2,
    shortCircuits: false,
    builtIn: true,
  },
  {
    strategy: 'full-pipeline',
    description: 'Code mutation with explicit target files; runs the complete 6-phase loop.',
    requiresTools: false,
    shortCircuits: false,
    builtIn: true,
  },
];

export class WorkflowRegistry {
  private readonly metadata = new Map<string, WorkflowMetadata>();

  constructor(initial: WorkflowMetadata[] = BUILT_IN_WORKFLOWS) {
    for (const m of initial) this.register(m);
  }

  register(meta: WorkflowMetadata): void {
    if (this.metadata.has(meta.strategy)) {
      throw new Error(`WorkflowRegistry: strategy '${meta.strategy}' already registered`);
    }
    this.metadata.set(meta.strategy, meta);
  }

  get(strategy: string): WorkflowMetadata | undefined {
    return this.metadata.get(strategy);
  }

  has(strategy: string): boolean {
    return this.metadata.has(strategy);
  }

  /** All registered strategy names, sorted. */
  list(): string[] {
    return Array.from(this.metadata.keys()).sort();
  }

  /** Strategies that short-circuit the pipeline. */
  listShortCircuits(): string[] {
    return this.list().filter((s) => this.metadata.get(s)?.shortCircuits === true);
  }

  /** Strategies the caller can safely fall through to when `strategy` is unknown. */
  fallback(): string {
    return 'full-pipeline';
  }
}
