/**
 * AgentRouter — deterministic, rule-first specialist selection.
 *
 * Decision order:
 *   1. CLI override (`input.agentId` set by `--agent <id>`) → 'override'
 *   2. Rule-based scoring over AgentSpec.routingHints
 *      - top score ≥ 0.4 AND margin-over-runner-up ≥ 0.15 → 'rule-match'
 *   3. LLM fallback (intent-resolver's agent catalog path) → 'llm'
 *   4. Registry default → 'default'
 *
 * A3 compliance: steps 1/2/4 are pure functions of deterministic inputs.
 * Only step 3 invokes an LLM — and its result is validated against the
 * registry before use (no hallucinated agent ids).
 *
 * The router produces a DECISION (agentId + reason + score) but does NOT
 * invoke the LLM itself — it returns a sentinel signalling "needs LLM" so
 * the caller (core-loop) can orchestrate the intent resolver call that's
 * already happening.
 */
import type { AgentSpec, PerceptualHierarchy, TaskInput } from './types.ts';
import type { AgentRegistry } from './agents/registry.ts';

export type AgentRouteReason = 'override' | 'rule-match' | 'needs-llm' | 'default';

export interface AgentRouteDecision {
  agentId: string;
  reason: AgentRouteReason;
  /** Normalized [0,1] score from rule evaluation. 0 for override/default/needs-llm. */
  score: number;
  /** Runner-up for observability (rule-match path only). */
  runnerUp?: { agentId: string; score: number };
}

export interface AgentRouter {
  /**
   * Select a specialist for this task.
   *
   * `routingLevel` is an optional hint. When provided, agents whose
   * `routingHints.minLevel` exceeds the task's routing level are excluded
   * from the rule-match candidate set — e.g., `system-designer` (minLevel:1)
   * is not considered for reflex-tier L0 tasks. When the hint is absent the
   * router keeps pre-multi-agent behaviour (minLevel ignored) so callers
   * that don't know the routing level yet still get a deterministic choice.
   */
  route(input: TaskInput, perception?: PerceptualHierarchy, routingLevel?: number): AgentRouteDecision;
}

/** Thresholds for rule-based selection. Tuned for 4 built-ins. */
const RULE_MIN_SCORE = 0.4;
const RULE_MIN_MARGIN = 0.15;

/** Weights from the approved plan. */
const WEIGHT_EXTENSIONS = 0.5;
const WEIGHT_FRAMEWORKS = 0.3;
const WEIGHT_DOMAINS = 0.2;

export interface DefaultAgentRouterDeps {
  registry: AgentRegistry;
}

export function createAgentRouter(deps: DefaultAgentRouterDeps): AgentRouter {
  return {
    route(input, perception, routingLevel) {
      const registry = deps.registry;

      // Step 1: CLI override — user selected the specialist explicitly
      if (input.agentId && registry.has(input.agentId)) {
        return { agentId: input.agentId, reason: 'override', score: 0 };
      }

      // Step 2: rule-based scoring
      const signals = extractSignals(input, perception);
      const allAgents = registry.listAgents();
      // Enforce minLevel hint when a routing level is available — specialists
      // that declare `minLevel:2` (e.g., system-designer when structural
      // reasoning is mandatory) are excluded from L0/L1 tasks. The default
      // agent is still the last-resort fallback below, so this never leaves
      // the router without a choice.
      const agents =
        typeof routingLevel === 'number'
          ? allAgents.filter((a) => {
              const min = a.routingHints?.minLevel;
              return min === undefined || routingLevel >= min;
            })
          : allAgents;
      const scored = agents.map((a) => ({ agent: a, score: scoreAgent(a, signals) }));
      scored.sort((a, b) => b.score - a.score);

      const top = scored[0];
      const runner = scored[1];
      if (top && top.score >= RULE_MIN_SCORE) {
        const margin = top.score - (runner?.score ?? 0);
        if (margin >= RULE_MIN_MARGIN) {
          return {
            agentId: top.agent.id,
            reason: 'rule-match',
            score: top.score,
            runnerUp: runner ? { agentId: runner.agent.id, score: runner.score } : undefined,
          };
        }
      }

      // Step 3: ambiguous — caller should invoke the LLM intent resolver
      // (the resolver will emit agentId in its response, core-loop wires it in).
      // We return the default as a placeholder, but mark `reason: 'needs-llm'`
      // so the caller knows to defer the final decision to the classifier.
      return {
        agentId: registry.defaultAgent().id,
        reason: 'needs-llm',
        score: top?.score ?? 0,
        runnerUp: runner ? { agentId: runner.agent.id, score: runner.score } : undefined,
      };
    },
  };
}

// ── Signal extraction ──────────────────────────────────────────────────

interface TaskSignals {
  extensions: Set<string>;
  frameworks: Set<string>;
  domains: Set<string>;
}

function extractSignals(input: TaskInput, perception?: PerceptualHierarchy): TaskSignals {
  const extensions = new Set<string>();
  for (const file of input.targetFiles ?? []) {
    const idx = file.lastIndexOf('.');
    if (idx >= 0) extensions.add(file.slice(idx).toLowerCase());
  }

  const frameworks = new Set<string>();
  if (perception?.frameworkMarkers) {
    for (const f of perception.frameworkMarkers) frameworks.add(f.toLowerCase());
  }

  const domains = new Set<string>();
  // Map TaskInput.taskType to a coarse domain signal.
  if (input.taskType === 'code') {
    domains.add(input.targetFiles?.length ? 'code-mutation' : 'code-reasoning');
  } else {
    domains.add('general-reasoning');
  }

  return { extensions, frameworks, domains };
}

function scoreAgent(agent: AgentSpec, signals: TaskSignals): number {
  const hints = agent.routingHints;
  if (!hints) return 0;

  let score = 0;
  if (hints.preferExtensions && hints.preferExtensions.length > 0) {
    const hits = hints.preferExtensions.filter((e) => signals.extensions.has(e.toLowerCase()));
    if (hits.length > 0) score += WEIGHT_EXTENSIONS;
  }
  if (hints.preferFrameworks && hints.preferFrameworks.length > 0) {
    const hits = hints.preferFrameworks.filter((f) => signals.frameworks.has(f.toLowerCase()));
    if (hits.length > 0) score += WEIGHT_FRAMEWORKS;
  }
  if (hints.preferDomains && hints.preferDomains.length > 0) {
    const hits = hints.preferDomains.filter((d) => signals.domains.has(d));
    if (hits.length > 0) score += WEIGHT_DOMAINS;
  }
  return score;
}
