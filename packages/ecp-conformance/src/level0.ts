/**
 * Level 0 Conformance — Minimal oracle validation.
 *
 * Level 0 requires:
 *   - Oracle reads HypothesisTuple JSON from stdin
 *   - Oracle writes OracleVerdict JSON to stdout
 *   - Verdict contains: verified, evidence, fileHashes, duration_ms/durationMs
 *   - Exit code 0 on success (verdict may still be verified: false)
 *   - Raw JSON transport (no JSON-RPC framing)
 */

import { Level0VerdictSchema } from './schemas.ts';

export interface Level0TestCase {
  name: string;
  input: {
    target: string;
    pattern: string;
    context?: Record<string, unknown>;
    workspace: string;
  };
  expectedVerified?: boolean;
}

export interface Level0Check {
  name: string;
  passed: boolean;
  error?: string;
}

export interface Level0Result {
  level: 0;
  passed: boolean;
  checks: Level0Check[];
}

/** Validate a verdict JSON string against Level 0 conformance. */
export function validateLevel0Verdict(verdictJson: string): Level0Check[] {
  const checks: Level0Check[] = [];

  // C1: Valid JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(verdictJson);
    checks.push({ name: 'valid-json', passed: true });
  } catch (e) {
    checks.push({ name: 'valid-json', passed: false, error: `Invalid JSON: ${e}` });
    return checks;
  }

  // C2: Schema validation (required fields)
  const result = Level0VerdictSchema.safeParse(parsed);
  if (result.success) {
    checks.push({ name: 'required-fields', passed: true });
  } else {
    checks.push({
      name: 'required-fields',
      passed: false,
      error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    });
    return checks;
  }

  const verdict = parsed as Record<string, unknown>;

  // C3: verified is boolean
  checks.push({
    name: 'verified-is-boolean',
    passed: typeof verdict.verified === 'boolean',
    error: typeof verdict.verified !== 'boolean' ? `Expected boolean, got ${typeof verdict.verified}` : undefined,
  });

  // C4: evidence is non-empty array
  const evidence = verdict.evidence as unknown[];
  checks.push({
    name: 'evidence-non-empty',
    passed: Array.isArray(evidence) && evidence.length > 0,
    error: !Array.isArray(evidence) || evidence.length === 0 ? 'evidence must be a non-empty array' : undefined,
  });

  // C5: fileHashes is non-empty
  const hashes = verdict.fileHashes as Record<string, string>;
  const hashKeys = Object.keys(hashes);
  checks.push({
    name: 'file-hashes-present',
    passed: hashKeys.length > 0,
    error: hashKeys.length === 0 ? 'fileHashes must contain at least one entry' : undefined,
  });

  // C6: fileHashes values look like SHA-256 (64 hex chars)
  const sha256Pattern = /^[a-f0-9]{64}$/;
  const invalidHashes = hashKeys.filter((k) => !sha256Pattern.test(hashes[k]!));
  checks.push({
    name: 'file-hashes-sha256',
    passed: invalidHashes.length === 0,
    error: invalidHashes.length > 0 ? `Non-SHA-256 hashes for: ${invalidHashes.join(', ')}` : undefined,
  });

  // C7: duration is non-negative
  const duration = (verdict.duration_ms ?? verdict.durationMs) as number;
  checks.push({
    name: 'duration-non-negative',
    passed: duration >= 0,
    error: duration < 0 ? `duration must be >= 0, got ${duration}` : undefined,
  });

  return checks;
}

/** Run Level 0 conformance validation on a verdict. */
export function validateLevel0(verdictJson: string): Level0Result {
  const checks = validateLevel0Verdict(verdictJson);
  return {
    level: 0,
    passed: checks.every((c) => c.passed),
    checks,
  };
}
