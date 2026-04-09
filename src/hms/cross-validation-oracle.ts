/**
 * Cross-Validation Oracle — multi-perspective probing to detect hallucination.
 *
 * Core idea (from research): hallucination = answers change with question framing;
 * knowledge = answers are stable across perspectives.
 *
 * A1 compliant: uses separate LLM call from generator.
 * A3 compliant: consistency scoring is deterministic.
 * A5 compliant: tier = 'heuristic' (uses LLM but structured verification).
 *
 * Source of truth: HMS plan §H3 (HMS-1)
 */
import type { ExtractedClaim } from './claim-grounding.ts';
import { generateProbes, type Probe } from './probe-templates.ts';
import type { CrossValidationResult } from './risk-scorer.ts';

/** LLM provider interface — minimal subset needed for probing. */
export interface ProbeProvider {
  generate(prompt: string, maxTokens: number): Promise<string>;
}

export interface CrossValidationConfig {
  maxProbesPerClaim: number;
  maxClaims: number;
  probeBudgetTokens: number;
}

const DEFAULT_CONFIG: CrossValidationConfig = {
  maxProbesPerClaim: 3,
  maxClaims: 5,
  probeBudgetTokens: 1000,
};

/**
 * Evaluate consistency of a single claim through probing.
 * Returns consistency score [0,1].
 */
function evaluateProbeResponse(probe: Probe, response: string, originalClaim: ExtractedClaim): number {
  const lower = response.toLowerCase().trim();
  const claimValue = originalClaim.value.toLowerCase();

  switch (probe.type) {
    case 'affirmation': {
      // Probe asked "Does X exist?" — check if response confirms
      const confirms =
        lower.includes('yes') || lower.includes('exists') || lower.includes('contains') || lower.includes(claimValue);
      const denies =
        lower.includes('no') || lower.includes('does not') || lower.includes("doesn't") || lower.includes('not found');
      if (confirms && !denies) return 1.0;
      if (denies && !confirms) return 0.0;
      return 0.5; // ambiguous
    }

    case 'negation': {
      // Probe asked "Is it true X does NOT exist?" — consistent if denied
      const confirmsNeg = lower.includes('yes') || lower.includes('correct') || lower.includes('true');
      const deniesNeg =
        lower.includes('no') || lower.includes('incorrect') || lower.includes('false') || lower.includes('actually');
      if (deniesNeg && !confirmsNeg) return 1.0; // denied negation = consistent with claim
      if (confirmsNeg && !deniesNeg) return 0.0; // confirmed negation = hallucination
      return 0.5;
    }

    case 'reframe': {
      // Probe asked open-ended question — check if claim value appears in response
      return lower.includes(claimValue) ? 1.0 : 0.3;
    }

    default:
      return 0.5;
  }
}

/**
 * Run cross-validation on a set of claims.
 *
 * @param claims — claims to validate (from HMS-2 claim extraction)
 * @param provider — LLM provider for probing (A1: MUST be separate from generator)
 * @param config — cross-validation configuration
 */
export async function crossValidate(
  claims: ExtractedClaim[],
  provider: ProbeProvider,
  config: CrossValidationConfig = DEFAULT_CONFIG,
): Promise<CrossValidationResult> {
  // Select high-priority claims (file refs and fake tool calls first)
  const prioritized = [...claims]
    .sort((a, b) => {
      const priority: Record<string, number> = {
        fake_tool_call: 0,
        file_reference: 1,
        import_claim: 2,
        symbol_reference: 3,
      };
      return (priority[a.type] ?? 4) - (priority[b.type] ?? 4);
    })
    .slice(0, config.maxClaims);

  if (prioritized.length === 0) {
    return { consistency: 1.0, probes_sent: 0 };
  }

  let totalConsistency = 0;
  let probesSent = 0;
  let claimsEvaluated = 0;

  for (const claim of prioritized) {
    const probes = generateProbes(claim).slice(0, config.maxProbesPerClaim);
    let claimConsistency = 0;
    let probeCount = 0;

    for (const probe of probes) {
      if (probesSent * 200 >= config.probeBudgetTokens) break; // budget check
      try {
        const response = await provider.generate(probe.prompt, 200);
        const score = evaluateProbeResponse(probe, response, claim);
        claimConsistency += score;
        probeCount++;
        probesSent++;
      } catch {
        // Probe failure — skip, don't penalize
      }
    }

    if (probeCount > 0) {
      totalConsistency += claimConsistency / probeCount;
      claimsEvaluated++;
    }
  }

  const consistency = claimsEvaluated > 0 ? totalConsistency / claimsEvaluated : 1.0;
  return { consistency: Math.min(1, Math.max(0, consistency)), probes_sent: probesSent };
}
