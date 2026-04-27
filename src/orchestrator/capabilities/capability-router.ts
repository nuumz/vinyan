/**
 * Capability Router internals — score how well each agent fits a task's
 * `CapabilityRequirement[]`. Pure deterministic scoring (A3): no LLM, no
 * regex on natural-language goal text. Rule-based, reproducible.
 *
 * The scorer produces:
 *   - `CapabilityFit` per agent, with matched/gap broken down per requirement
 *   - `CapabilityGapAnalysis` with the best candidate + recommendedAction
 *
 * `recommendedAction` is advisory metadata for the orchestrator/UI/traces.
 * It does NOT bypass routing or rewrite LLM output; it just records whether
 * the best agent's gap is small (proceed), moderate (research), or large
 * enough that synthesizing a task-scoped agent should be considered.
 */
import type {
  AgentCapabilityProfile,
  AgentSpec,
  CapabilityClaim,
  CapabilityFit,
  CapabilityGapAnalysis,
  CapabilityRequirement,
} from '../types.ts';
import { buildAgentCapabilityProfile, buildAgentCapabilityProfiles } from './profile-adapter.ts';

/**
 * Action thresholds. Tuned so:
 *   - all requirements satisfied → 'proceed'
 *   - one secondary dimension missed → still 'proceed'
 *   - half the weighted requirements unmet → 'research'
 *   - mostly unmet → 'synthesize'
 */
const PROCEED_MAX = 0.4;
const RESEARCH_MAX = 0.7;

/** Score a single agent against a list of requirements. */
export function scoreFit(agent: AgentSpec, requirements: readonly CapabilityRequirement[]): CapabilityFit {
  return scoreProfile(buildAgentCapabilityProfile(agent), requirements);
}

/** Score a single capability profile against a list of requirements. */
export function scoreProfile(
  profile: AgentCapabilityProfile,
  requirements: readonly CapabilityRequirement[],
): CapabilityFit {
  const matched: CapabilityFit['matched'] = [];
  const gap: CapabilityFit['gap'] = [];
  const claims = profile.claims;
  const agentRoles = new Set(profile.roles);

  let weightedScore = 0;
  for (const req of requirements) {
    let bestMatch = 0;
    let bestConfidence = 0;

    // Role match short-circuit. A role declared in `agent.roles` is a strong
    // structural signal independent of capability claims.
    if (req.role && agentRoles.has(req.role)) {
      bestMatch = 1;
      bestConfidence = 1;
    }

    for (const claim of claims) {
      const overlap = signalOverlap(req, claim);
      if (overlap === 0) continue;
      const m = overlap * claim.confidence;
      if (m > bestMatch) {
        bestMatch = m;
        bestConfidence = claim.confidence;
      }
    }

    if (bestMatch > 0) {
      matched.push({ id: req.id, weight: req.weight, confidence: bestConfidence });
      weightedScore += bestMatch * req.weight;
    } else {
      gap.push({ id: req.id, weight: req.weight });
    }
  }

  return {
    agentId: profile.routeTargetId,
    profileId: profile.id,
    profileSource: profile.source,
    trustTier: profile.trustTier,
    fitScore: weightedScore,
    matched,
    gap,
  };
}

/**
 * Compute how well a single requirement aligns with a single capability claim.
 * Returns a value in [0, 1]:
 *   - 1.0 when claim id matches requirement id
 *   - hits / dimensions otherwise (intersection on each declared dimension)
 *   - 0 when no requested dimension overlaps
 */
function signalOverlap(req: CapabilityRequirement, claim: CapabilityClaim): number {
  if (req.id === claim.id) return 1;

  let dims = 0;
  let hits = 0;

  if (req.fileExtensions && req.fileExtensions.length > 0) {
    dims++;
    if (claim.fileExtensions?.some((e) => req.fileExtensions?.includes(e))) hits++;
  }
  if (req.actionVerbs && req.actionVerbs.length > 0) {
    dims++;
    if (claim.actionVerbs?.some((v) => req.actionVerbs?.includes(v))) hits++;
  }
  if (req.domains && req.domains.length > 0) {
    dims++;
    if (claim.domains?.some((d) => req.domains?.includes(d))) hits++;
  }
  if (req.frameworkMarkers && req.frameworkMarkers.length > 0) {
    dims++;
    if (claim.frameworkMarkers?.some((f) => req.frameworkMarkers?.includes(f))) hits++;
  }
  if (req.role) {
    dims++;
    if (claim.role === req.role) hits++;
  }

  if (dims === 0) return 0;
  return hits / dims;
}

/** Rank agents by fit and emit a `CapabilityGapAnalysis`. */
export function analyzeFit(
  taskId: string,
  agents: readonly AgentSpec[],
  requirements: readonly CapabilityRequirement[],
): CapabilityGapAnalysis {
  return analyzeProfileFit(taskId, buildAgentCapabilityProfiles(agents), requirements);
}

/** Rank capability profiles by fit and emit a `CapabilityGapAnalysis`. */
export function analyzeProfileFit(
  taskId: string,
  profiles: readonly AgentCapabilityProfile[],
  requirements: readonly CapabilityRequirement[],
): CapabilityGapAnalysis {
  const candidates = profiles.map((profile) => scoreProfile(profile, requirements)).sort((a, b) => b.fitScore - a.fitScore);

  const totalWeight = requirements.reduce((s, r) => s + r.weight, 0);
  const best = candidates[0];
  const unmetWeight = best ? best.gap.reduce((s, g) => s + g.weight, 0) : totalWeight;
  const gapNormalized = totalWeight > 0 ? unmetWeight / totalWeight : 1;

  let recommendedAction: CapabilityGapAnalysis['recommendedAction'];
  if (!best) {
    recommendedAction = 'fallback';
  } else if (best.fitScore <= 0) {
    recommendedAction = 'synthesize';
  } else if (gapNormalized <= PROCEED_MAX) {
    recommendedAction = 'proceed';
  } else if (gapNormalized <= RESEARCH_MAX) {
    recommendedAction = 'research';
  } else {
    recommendedAction = 'synthesize';
  }

  return {
    taskId,
    required: [...requirements],
    candidates,
    gapNormalized,
    recommendedAction,
  };
}
