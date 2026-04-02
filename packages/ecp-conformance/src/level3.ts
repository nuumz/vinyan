/**
 * Level 3 Conformance — Platform oracle validation.
 *
 * Level 3 adds to Level 2:
 *   - Cross-instance verdict provenance (sourceInstanceId)
 *   - Remote verdict confidence ceiling (0.95, invariant I13)
 *   - Knowledge sharing protocol validation (offer/accept/transfer)
 *   - Optional message signing structure
 */

import {
  Level3VerdictSchema,
  KnowledgeOfferSchema,
  KnowledgeAcceptanceSchema,
  KnowledgeTransferSchema,
} from './schemas.ts';

export interface Level3Check {
  name: string;
  passed: boolean;
  error?: string;
}

export interface Level3Result {
  level: 3;
  passed: boolean;
  checks: Level3Check[];
}

/** Maximum confidence for remote verdicts (I13: no remote governance bypass). */
const REMOTE_CONFIDENCE_CEILING = 0.95;

/** Validate a verdict against Level 3 conformance. */
export function validateLevel3Verdict(verdictJson: string): Level3Check[] {
  const checks: Level3Check[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(verdictJson);
    checks.push({ name: 'valid-json', passed: true });
  } catch (e) {
    checks.push({ name: 'valid-json', passed: false, error: `Invalid JSON: ${e}` });
    return checks;
  }

  // C1: Schema validation (Level 3 extends Level 2)
  const result = Level3VerdictSchema.safeParse(parsed);
  if (result.success) {
    checks.push({ name: 'level3-schema', passed: true });
  } else {
    checks.push({
      name: 'level3-schema',
      passed: false,
      error: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    });
    return checks;
  }

  const verdict = parsed as Record<string, unknown>;

  // C2: sourceInstanceId is non-empty
  checks.push({
    name: 'source-instance-id',
    passed: typeof verdict.sourceInstanceId === 'string' && (verdict.sourceInstanceId as string).length > 0,
  });

  // C3: Remote verdict confidence ceiling (I13)
  const origin = verdict.origin as string | undefined;
  const confidence = verdict.confidence as number;
  if (origin === 'a2a') {
    checks.push({
      name: 'remote-confidence-ceiling',
      passed: confidence <= REMOTE_CONFIDENCE_CEILING,
      error: confidence > REMOTE_CONFIDENCE_CEILING
        ? `Remote verdict confidence ${confidence} exceeds ceiling ${REMOTE_CONFIDENCE_CEILING}`
        : undefined,
    });
  }

  // C4: If signature present, signerInstanceId must also be present
  const signature = verdict.signature as string | undefined;
  const signerInstanceId = verdict.signerInstanceId as string | undefined;
  if (signature) {
    checks.push({
      name: 'signature-has-signer',
      passed: !!signerInstanceId && signerInstanceId.length > 0,
      error: !signerInstanceId ? 'signature present but signerInstanceId missing' : undefined,
    });

    // C5: Signature looks like hex
    const hexPattern = /^[a-f0-9]+$/i;
    checks.push({
      name: 'signature-hex-format',
      passed: hexPattern.test(signature),
      error: !hexPattern.test(signature) ? 'signature is not valid hex' : undefined,
    });
  }

  return checks;
}

/** Validate a knowledge offer message. */
export function validateKnowledgeOffer(offerJson: string): Level3Check[] {
  const checks: Level3Check[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(offerJson);
    checks.push({ name: 'offer-valid-json', passed: true });
  } catch (e) {
    checks.push({ name: 'offer-valid-json', passed: false, error: `Invalid JSON: ${e}` });
    return checks;
  }

  const result = KnowledgeOfferSchema.safeParse(parsed);
  checks.push({
    name: 'offer-schema',
    passed: result.success,
    error: !result.success
      ? result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
      : undefined,
  });

  if (result.success) {
    const offer = parsed as { patterns: Array<{ confidence: number }> };
    // All pattern confidences must be in [0, 1]
    const invalidConf = offer.patterns.filter((p) => p.confidence < 0 || p.confidence > 1);
    checks.push({
      name: 'offer-confidence-bounds',
      passed: invalidConf.length === 0,
      error: invalidConf.length > 0 ? `${invalidConf.length} patterns with out-of-range confidence` : undefined,
    });
  }

  return checks;
}

/** Validate a knowledge acceptance message. */
export function validateKnowledgeAcceptance(acceptJson: string): Level3Check[] {
  const checks: Level3Check[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(acceptJson);
    checks.push({ name: 'accept-valid-json', passed: true });
  } catch (e) {
    checks.push({ name: 'accept-valid-json', passed: false, error: `Invalid JSON: ${e}` });
    return checks;
  }

  const result = KnowledgeAcceptanceSchema.safeParse(parsed);
  checks.push({
    name: 'accept-schema',
    passed: result.success,
    error: !result.success
      ? result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
      : undefined,
  });

  return checks;
}

/** Validate a knowledge transfer message. */
export function validateKnowledgeTransfer(transferJson: string): Level3Check[] {
  const checks: Level3Check[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(transferJson);
    checks.push({ name: 'transfer-valid-json', passed: true });
  } catch (e) {
    checks.push({ name: 'transfer-valid-json', passed: false, error: `Invalid JSON: ${e}` });
    return checks;
  }

  const result = KnowledgeTransferSchema.safeParse(parsed);
  checks.push({
    name: 'transfer-schema',
    passed: result.success,
    error: !result.success
      ? result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
      : undefined,
  });

  if (result.success) {
    const transfer = parsed as { patterns: Array<{ confidence: number }> };
    // I14: Imported patterns should have reduced confidence (≤ 0.5 of original)
    // We can only check that confidence is reasonable, not the reduction factor
    const highConf = transfer.patterns.filter((p) => p.confidence > REMOTE_CONFIDENCE_CEILING);
    checks.push({
      name: 'transfer-confidence-ceiling',
      passed: highConf.length === 0,
      error: highConf.length > 0
        ? `${highConf.length} transferred patterns exceed confidence ceiling ${REMOTE_CONFIDENCE_CEILING}`
        : undefined,
    });
  }

  return checks;
}

/** Run Level 3 conformance validation on a verdict. */
export function validateLevel3(verdictJson: string): Level3Result {
  const checks = validateLevel3Verdict(verdictJson);
  return {
    level: 3,
    passed: checks.every((c) => c.passed),
    checks,
  };
}
