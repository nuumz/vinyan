/**
 * Risk Router Adapter — wraps Phase 0 risk scoring for the Orchestrator.
 *
 * Implements the RiskRouter interface from core-loop.ts by populating
 * RiskFactors from TaskInput and delegating to Phase 0's pure functions.
 *
 * Source of truth: spec/tdd.md §6, §16.2
 */
import { existsSync } from "fs";
import { join, dirname, basename } from "path";
import type { HypothesisTuple } from "../core/types.ts";
import { calculateRiskScore, routeByRisk, detectEnvironment, type RoutingThresholds } from "../gate/risk-router.ts";
import type { RiskFactors, RoutingLevel, RoutingDecision, TaskInput } from "./types.ts";
import type { RiskRouter } from "./core-loop.ts";

type DepVerify = (hypothesis: HypothesisTuple) => Promise<{ evidence: { file: string }[] }>;

/** Compute file volatility from git history (commits in last 30 days, normalized 0–1). */
export function computeFileVolatility(filePath: string, workspace: string): number {
  try {
    // Fast-path: skip git spawn if workspace isn't a git repo
    if (!existsSync(join(workspace, ".git"))) return 0;
    const result = Bun.spawnSync(
      ["git", "log", "--oneline", "--since=30 days ago", "--", filePath],
      { cwd: workspace },
    );
    if (result.exitCode !== 0) return 0;
    const stdout = new TextDecoder().decode(result.stdout).trim();
    const lines = stdout.split("\n").filter(l => l.length > 0);
    return Math.min(1.0, lines.length / 30);
  } catch {
    return 0;
  }
}

/** Check if test files exist for the target file. Returns 0.8 if any found, 0.0 if none. */
export function computeTestCoverage(filePath: string, workspace: string): number {
  const name = basename(filePath).replace(/\.(ts|tsx|js|jsx)$/, "");
  const dir = dirname(filePath);
  const candidates = [
    join(workspace, dir, `${name}.test.ts`),
    join(workspace, dir, `${name}.spec.ts`),
    join(workspace, "tests", dir.replace(/^src\/?/, ""), `${name}.test.ts`),
    join(workspace, "tests", `${name}.test.ts`),
  ];
  return candidates.some(f => existsSync(f)) ? 0.8 : 0.0;
}

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

    // Build RiskFactors — compute real values for testCoverage and fileVolatility
    const targetFile = input.targetFiles?.[0];
    const testCoverage = targetFile ? computeTestCoverage(targetFile, this.workspace) : 0.5;
    const fileVolatility = targetFile ? computeFileVolatility(targetFile, this.workspace) : 0;

    const factors: RiskFactors = {
      blastRadius,
      dependencyDepth: 0,
      testCoverage,
      fileVolatility,
      irreversibility: 0.5,
      hasSecurityImplication: false,
      environmentType: detectEnvironment(),
    };

    const score = calculateRiskScore(factors);
    const decision = routeByRisk(score, blastRadius, this.thresholds, factors.environmentType);
    decision.riskScore = score;

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
