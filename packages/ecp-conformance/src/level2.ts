/**
 * Level 2 Conformance — Full oracle validation.
 *
 * Level 2 adds to Level 1:
 *   - Version negotiation handshake (ecp/register)
 *   - temporal_context validity
 *   - deliberation_request support
 *   - Concurrent hypothesis support
 */

import { Level2VerdictSchema, VersionHandshakeSchema, VersionResponseSchema } from './schemas.ts';

export interface Level2Check {
  name: string;
  passed: boolean;
  error?: string;
}

export interface Level2Result {
  level: 2;
  passed: boolean;
  checks: Level2Check[];
}

/** Validate a verdict against Level 2 conformance. */
export function validateLevel2Verdict(verdictJson: string): Level2Check[] {
  const checks: Level2Check[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(verdictJson);
    checks.push({ name: 'valid-json', passed: true });
  } catch (e) {
    checks.push({ name: 'valid-json', passed: false, error: `Invalid JSON: ${e}` });
    return checks;
  }

  const result = Level2VerdictSchema.safeParse(parsed);
  if (result.success) {
    checks.push({ name: 'level2-schema', passed: true });
  } else {
    checks.push({
      name: 'level2-schema',
      passed: false,
      error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    });
    return checks;
  }

  const verdict = parsed as Record<string, unknown>;

  // C1: temporal_context validity (if present)
  const tc = verdict.temporalContext as { validFrom: number; validUntil: number; decayModel: string } | undefined;
  if (tc) {
    checks.push({
      name: 'temporal-context-order',
      passed: tc.validFrom < tc.validUntil,
      error: tc.validFrom >= tc.validUntil
        ? `validFrom (${tc.validFrom}) must be before validUntil (${tc.validUntil})`
        : undefined,
    });

    checks.push({
      name: 'temporal-context-decay-model',
      passed: ['linear', 'step', 'none'].includes(tc.decayModel),
    });
  }

  // C2: deliberation_request validity (if present)
  const dr = verdict.deliberationRequest as { reason: string; suggestedBudget: number } | undefined;
  if (dr) {
    checks.push({
      name: 'deliberation-reason-non-empty',
      passed: dr.reason.length > 0,
      error: dr.reason.length === 0 ? 'deliberation reason must not be empty' : undefined,
    });

    checks.push({
      name: 'deliberation-budget-positive',
      passed: dr.suggestedBudget > 0,
      error: dr.suggestedBudget <= 0 ? `suggestedBudget must be > 0, got ${dr.suggestedBudget}` : undefined,
    });
  }

  return checks;
}

/** Validate version negotiation handshake. */
export function validateVersionHandshake(requestJson: string): Level2Check[] {
  const checks: Level2Check[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(requestJson);
    checks.push({ name: 'handshake-valid-json', passed: true });
  } catch (e) {
    checks.push({ name: 'handshake-valid-json', passed: false, error: `Invalid JSON: ${e}` });
    return checks;
  }

  const result = VersionHandshakeSchema.safeParse(parsed);
  if (result.success) {
    checks.push({ name: 'handshake-schema', passed: true });
  } else {
    checks.push({
      name: 'handshake-schema',
      passed: false,
      error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    });
    return checks;
  }

  const handshake = parsed as { ecp_version: number; supported_versions: number[] };

  // C1: Preferred version is in supported list
  checks.push({
    name: 'preferred-in-supported',
    passed: handshake.supported_versions.includes(handshake.ecp_version),
    error: !handshake.supported_versions.includes(handshake.ecp_version)
      ? `ecp_version ${handshake.ecp_version} not in supported_versions [${handshake.supported_versions}]`
      : undefined,
  });

  return checks;
}

/** Validate version negotiation response. */
export function validateVersionResponse(responseJson: string, supportedVersions: number[]): Level2Check[] {
  const checks: Level2Check[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseJson);
    checks.push({ name: 'response-valid-json', passed: true });
  } catch (e) {
    checks.push({ name: 'response-valid-json', passed: false, error: `Invalid JSON: ${e}` });
    return checks;
  }

  const result = VersionResponseSchema.safeParse(parsed);
  if (result.success) {
    checks.push({ name: 'response-schema', passed: true });
  } else {
    checks.push({
      name: 'response-schema',
      passed: false,
      error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    });
    return checks;
  }

  const response = parsed as { negotiated_version: number };

  // C1: Negotiated version is in the engine's supported list
  checks.push({
    name: 'negotiated-version-supported',
    passed: supportedVersions.includes(response.negotiated_version),
    error: !supportedVersions.includes(response.negotiated_version)
      ? `negotiated_version ${response.negotiated_version} not in supported [${supportedVersions}]`
      : undefined,
  });

  return checks;
}

/** Run Level 2 conformance validation on a verdict. */
export function validateLevel2(verdictJson: string): Level2Result {
  const checks = validateLevel2Verdict(verdictJson);
  return {
    level: 2,
    passed: checks.every((c) => c.passed),
    checks,
  };
}
