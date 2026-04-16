/**
 * Level 1 Conformance — Standard oracle validation.
 *
 * Level 1 adds to Level 0:
 *   - All 4 epistemic types: known, unknown, uncertain, contradictory
 *   - Confidence in [0, 1] range
 *   - evidence[].contentHash required (A4 compliance)
 *   - falsifiable_by follows formal grammar: scope:target:event
 *   - JSON-RPC 2.0 framing (validated separately for network transports)
 */

import { FalsifiabilityConditionPattern, Level1VerdictSchema, JsonRpcResponseSchema } from './schemas.ts';

export interface Level1Check {
  name: string;
  passed: boolean;
  error?: string;
}

export interface Level1Result {
  level: 1;
  passed: boolean;
  checks: Level1Check[];
}

/** Validate a verdict against Level 1 conformance. */
export function validateLevel1Verdict(verdictJson: string): Level1Check[] {
  const checks: Level1Check[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(verdictJson);
    checks.push({ name: 'valid-json', passed: true });
  } catch (e) {
    checks.push({ name: 'valid-json', passed: false, error: `Invalid JSON: ${e}` });
    return checks;
  }

  // C1: Schema validation
  const result = Level1VerdictSchema.safeParse(parsed);
  if (result.success) {
    checks.push({ name: 'level1-schema', passed: true });
  } else {
    checks.push({
      name: 'level1-schema',
      passed: false,
      error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    });
    return checks;
  }

  const verdict = parsed as Record<string, unknown>;

  // C2: Epistemic type is one of 4 valid values
  const validTypes = ['known', 'unknown', 'uncertain', 'contradictory'];
  checks.push({
    name: 'epistemic-type-valid',
    passed: validTypes.includes(verdict.type as string),
  });

  // C3: Confidence bounded by type semantics
  const confidence = verdict.confidence as number;
  const type = verdict.type as string;
  if (type === 'known') {
    checks.push({
      name: 'known-confidence-high',
      passed: confidence >= 0.9,
      error: confidence < 0.9 ? `type=known expects confidence >= 0.9, got ${confidence}` : undefined,
    });
  } else if (type === 'unknown') {
    checks.push({
      name: 'unknown-confidence-low',
      passed: confidence <= 0.5,
      error: confidence > 0.5 ? `type=unknown expects confidence <= 0.5, got ${confidence}` : undefined,
    });
  } else {
    checks.push({ name: 'confidence-range', passed: confidence >= 0 && confidence <= 1 });
  }

  // C4: evidence[].contentHash is present (A4)
  const evidence = verdict.evidence as Array<Record<string, unknown>>;
  const missingHash = evidence.filter((e) => !e.contentHash);
  checks.push({
    name: 'evidence-content-hash',
    passed: missingHash.length === 0,
    error: missingHash.length > 0 ? `${missingHash.length} evidence entries missing contentHash` : undefined,
  });

  // C5: falsifiableBy follows formal grammar
  const falsifiableBy = (verdict.falsifiableBy ?? []) as string[];
  const invalidConditions = falsifiableBy.filter((c) => !FalsifiabilityConditionPattern.test(c));
  checks.push({
    name: 'falsifiable-grammar',
    passed: invalidConditions.length === 0,
    error: invalidConditions.length > 0
      ? `Invalid falsifiable_by conditions: ${invalidConditions.join(', ')}`
      : undefined,
  });

  // C6: SL opinion consistency — if present, b+d+u must equal 1.0 (±0.001)
  const opinion = verdict.opinion as { belief: number; disbelief: number; uncertainty: number; baseRate: number } | undefined;
  if (opinion) {
    const sum = opinion.belief + opinion.disbelief + opinion.uncertainty;
    const withinTolerance = Math.abs(sum - 1.0) < 0.001;
    checks.push({
      name: 'sl-opinion-sum',
      passed: withinTolerance,
      error: withinTolerance ? undefined : `SL opinion b+d+u=${sum.toFixed(6)}, expected 1.0 (±0.001)`,
    });

    // Verify all components are non-negative
    const allNonNeg = opinion.belief >= 0 && opinion.disbelief >= 0 && opinion.uncertainty >= 0 && opinion.baseRate >= 0;
    checks.push({
      name: 'sl-opinion-non-negative',
      passed: allNonNeg,
      error: allNonNeg ? undefined : 'SL opinion components must be non-negative',
    });
  }

  return checks;
}

/** Validate JSON-RPC 2.0 response envelope (for network transports). */
export function validateJsonRpcEnvelope(responseJson: string): Level1Check[] {
  const checks: Level1Check[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseJson);
    checks.push({ name: 'jsonrpc-valid-json', passed: true });
  } catch (e) {
    checks.push({ name: 'jsonrpc-valid-json', passed: false, error: `Invalid JSON: ${e}` });
    return checks;
  }

  const result = JsonRpcResponseSchema.safeParse(parsed);
  checks.push({
    name: 'jsonrpc-envelope',
    passed: result.success,
    error: !result.success
      ? result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
      : undefined,
  });

  return checks;
}

/** Run Level 1 conformance validation on a verdict. */
export function validateLevel1(verdictJson: string): Level1Result {
  const checks = validateLevel1Verdict(verdictJson);
  return {
    level: 1,
    passed: checks.every((c) => c.passed),
    checks,
  };
}
