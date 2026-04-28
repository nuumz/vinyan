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

import type { AgentRegistry } from './agents/registry.ts';
import { analyzeRequirements } from './capabilities/capability-analyzer.ts';
import { analyzeProfileFit } from './capabilities/capability-router.ts';
import { buildAgentCapabilityProfilesFromRegistry } from './capabilities/profile-adapter.ts';
import type { CapabilityGapAnalysis, CapabilityRequirement, PerceptualHierarchy, TaskInput } from './types.ts';

export type AgentRouteReason = 'override' | 'rule-match' | 'needs-llm' | 'default' | 'synthesized';

export interface AgentRouteDecision {
  agentId: string;
  reason: AgentRouteReason;
  /** Composite weighted fit score from capability evaluation. 0 for override/default/needs-llm. */
  score: number;
  /** Runner-up for observability (rule-match path only). */
  runnerUp?: { agentId: string; score: number };
  /** Capability gap analysis attached when the router actually scored agents. */
  capabilityAnalysis?: CapabilityGapAnalysis;
}

export interface AgentRouter {
  /**
   * Select a specialist for this task.
   *
   * `routingLevel` is an optional hint. When provided, agents whose
   * `routingHints.minLevel` exceeds the task's routing level are excluded
   * from the rule-match candidate set — e.g., `architect` (minLevel:1)
   * is not considered for reflex-tier L0 tasks. When the hint is absent the
   * router keeps pre-multi-agent behaviour (minLevel ignored) so callers
   * that don't know the routing level yet still get a deterministic choice.
   *
   * `requirements` lets the caller inject extra CapabilityRequirements
   * (e.g. LLM-extracted via the intent resolver). They are merged with the
   * fingerprint-derived requirements by the analyzer and contribute to the
   * deterministic fit scoring — they do NOT bypass scoring.
   */
  route(
    input: TaskInput,
    perception?: PerceptualHierarchy,
    routingLevel?: number,
    requirements?: CapabilityRequirement[],
  ): AgentRouteDecision;
}

/** Thresholds for rule-based selection. Tuned for 4 built-ins. */
const RULE_MIN_SCORE = 0.4;
const RULE_MIN_MARGIN = 0.15;

export interface DefaultAgentRouterDeps {
  registry: AgentRegistry;
}

export function createAgentRouter(deps: DefaultAgentRouterDeps): AgentRouter {
  return {
    route(input, perception, routingLevel, requirements) {
      const registry = deps.registry;

      // Step 1: CLI override — user selected the specialist explicitly
      if (input.agentId && registry.has(input.agentId)) {
        return { agentId: input.agentId, reason: 'override', score: 0 };
      }

      // Step 2: capability-first scoring. Agents compete on declared
      // CapabilityClaims, which the capability-analyzer matches against
      // task requirements derived from the fingerprint and (optionally)
      // LLM-extracted requirements forwarded by the caller.
      //
      // Phase-2 wiring: profiles are built via the registry helper so each
      // agent's skill-derived claims and skill-narrowed ACL flow into the
      // routing layer. Without a skill resolver wired, derivation returns
      // raw spec data and behavior is unchanged.
      const allProfiles = buildAgentCapabilityProfilesFromRegistry(registry.listAgents(), (id) =>
        registry.getDerivedCapabilities(id),
      );
      const profiles =
        typeof routingLevel === 'number'
          ? allProfiles.filter((profile) => {
              const min = profile.routingHints?.minLevel;
              return min === undefined || routingLevel >= min;
            })
          : allProfiles;

      const analyzed: CapabilityRequirement[] = analyzeRequirements({
        task: input,
        perception,
        requirements,
      });
      const analysis = analyzeProfileFit(input.id, profiles, analyzed);
      const top = analysis.candidates[0];
      const runner = analysis.candidates[1];

      if (top && top.fitScore >= RULE_MIN_SCORE) {
        const margin = top.fitScore - (runner?.fitScore ?? 0);
        if (margin >= RULE_MIN_MARGIN) {
          return {
            agentId: top.agentId,
            reason: 'rule-match',
            score: top.fitScore,
            runnerUp: runner ? { agentId: runner.agentId, score: runner.fitScore } : undefined,
            capabilityAnalysis: analysis,
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
        score: top?.fitScore ?? 0,
        runnerUp: runner ? { agentId: runner.agentId, score: runner.fitScore } : undefined,
        capabilityAnalysis: analysis,
      };
    },
  };
}
