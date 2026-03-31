/**
 * Risk Router Adapter — wraps Phase 0 risk scoring for the Orchestrator.
 *
 * Implements the RiskRouter interface from core-loop.ts by populating
 * RiskFactors from TaskInput and delegating to Phase 0's pure functions.
 *
 * Source of truth: vinyan-tdd.md §6, §16.2
 */
import type { HypothesisTuple } from "../core/types.ts";
import { calculateRiskScore, routeByRisk, detectEnvironment, type RoutingThresholds } from "../gate/risk-router.ts";
import type { RiskFactors, RoutingLevel, RoutingDecision, TaskInput } from "./types.ts";
import type { RiskRouter } from "./core-loop.ts";

type DepVerify = (hypothesis: HypothesisTuple) => Promise<{ evidence: { file: string }[] }>;

export class RiskRouterImpl implements RiskRouter {
  private thresholds?: RoutingThresholds;

  constructor(
    private depVerify: DepVerify,
    private workspace: string = process.cwd(),
    /** Pass config-sourced thresholds to unify with gate's routing (Gap #14). */
    thresholds?: RoutingThresholds,
  ) {
    this.thresholds = thresholds;
  }

  async assessInitialLevel(input: TaskInput): Promise<RoutingDecision> {
    // Compute blast radius via dep-oracle
    let blastRadius = 0;
    if (input.targetFiles?.length) {
      try {
        const verdict = await this.depVerify({
          target: input.targetFiles[0]!,
          pattern: "dependency-check",
          workspace: this.workspace,
        });
        blastRadius = verdict.evidence.length;
      } catch {
        // dep-oracle failed — use conservative default
        blastRadius = 1;
      }
    }

    // Build RiskFactors with conservative defaults for unknown dimensions
    const factors: RiskFactors = {
      blastRadius,
      dependencyDepth: 0,
      testCoverage: 0.5,
      fileVolatility: 0,
      irreversibility: 0.5,
      hasSecurityImplication: false,
      environmentType: detectEnvironment(),
    };

    const score = calculateRiskScore(factors);
    const decision = routeByRisk(score, blastRadius, this.thresholds);

    // Parse MIN_ROUTING_LEVEL:N from constraints (core-loop injects on escalation)
    const minLevel = parseMinRoutingLevel(input.constraints);
    if (minLevel !== undefined && decision.level < minLevel) {
      decision.level = minLevel;
    }

    return decision;
  }
}

/** Extract minimum routing level from constraints array. */
function parseMinRoutingLevel(constraints?: string[]): RoutingLevel | undefined {
  if (!constraints) return undefined;
  for (const c of constraints) {
    const match = c.match(/^MIN_ROUTING_LEVEL:(\d)$/);
    if (match) {
      const level = parseInt(match[1]!, 10);
      if (level >= 0 && level <= 3) return level as RoutingLevel;
    }
  }
  return undefined;
}
