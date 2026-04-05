/**
 * Goal Alignment Oracle — verifies that LLM output aligns with TaskUnderstanding intent.
 *
 * Four deterministic checks (all rule-based, A3-safe — no LLM in verification path):
 * 1. Mutation expectation: expectsMutation vs actual mutations
 * 2. Target symbol coverage: targetSymbol set → mutations must touch it
 * 3. Action-verb alignment: verb category → expected mutation pattern
 * 4. File scope: targetFiles specified → mutations must overlap
 *
 * A1 Understanding layer: Ensures generation (Worker) matches user intent (TaskUnderstanding).
 * Tier: heuristic (0.7 confidence cap) — symbol/verb matching is approximate.
 * Classification: INFORMATIONAL — warns only, never blocks (until calibrated via trace data).
 */
import { buildVerdict } from '../../core/index.ts';
import { fromScalar } from '../../core/subjective-opinion.ts';
import type { Evidence, HypothesisTuple, OracleAbstention, OracleResponse } from '../../core/types.ts';
import type { TaskUnderstanding } from '../../orchestrator/types.ts';

const BASE_RATE = 0.5;
const TTL_MS = 300_000;
const MAX_CONFIDENCE = 0.7; // heuristic tier cap

// ── Verb → expected outcome mapping ────────────────────────────
// Only the ~10 most common verbs are mapped; unknown verbs → abstain on that check.

interface VerbExpectation {
  /** Expects new files to be created? */
  expectsNewFiles?: boolean;
  /** Expects only existing files to be modified (no new files)? */
  expectsExistingOnly?: boolean;
  /** Expects deletions or reduced content? */
  expectsDeletions?: boolean;
}

const VERB_EXPECTATIONS: Record<string, VerbExpectation> = {
  add: { expectsNewFiles: true },
  create: { expectsNewFiles: true },
  implement: { expectsNewFiles: true },
  refactor: { expectsExistingOnly: true },
  rename: { expectsExistingOnly: true },
  fix: { expectsExistingOnly: true },
  debug: { expectsExistingOnly: true },
  delete: { expectsDeletions: true },
  remove: { expectsDeletions: true },
  clean: { expectsDeletions: true },
};

// ── Check implementations ──────────────────────────────────────

interface CheckResult {
  name: string;
  passed: boolean;
  evidence: Evidence[];
  reason?: string;
}

/**
 * Check 1: Mutation expectation — does expectsMutation match actual mutations?
 * Analysis task producing file changes = mismatch.
 * Mutation task producing no changes = mismatch.
 */
function checkMutationExpectation(understanding: TaskUnderstanding, hypothesis: HypothesisTuple): CheckResult {
  const hasMutationContent = !!hypothesis.context?.content;
  const evidence: Evidence[] = [];

  if (understanding.expectsMutation && !hasMutationContent) {
    evidence.push({
      file: hypothesis.target,
      line: 0,
      snippet: `Expected mutation (actionVerb: '${understanding.actionVerb}') but no content produced`,
    });
    return { name: 'mutation-expectation', passed: false, evidence, reason: 'Expected mutation but none produced' };
  }

  if (!understanding.expectsMutation && hasMutationContent) {
    evidence.push({
      file: hypothesis.target,
      line: 0,
      snippet: `Analysis task (actionCategory: '${understanding.actionCategory}') produced file mutations`,
    });
    return {
      name: 'mutation-expectation',
      passed: false,
      evidence,
      reason: 'Analysis task should not produce mutations',
    };
  }

  return { name: 'mutation-expectation', passed: true, evidence };
}

/**
 * Check 2: Target symbol coverage — if targetSymbol is set, at least one mutation
 * must contain that symbol name (case-sensitive string search in content).
 */
function checkTargetSymbolCoverage(understanding: TaskUnderstanding, hypothesis: HypothesisTuple): CheckResult {
  const evidence: Evidence[] = [];

  if (!understanding.targetSymbol) {
    // No target symbol specified → check not applicable → pass
    return { name: 'target-symbol', passed: true, evidence };
  }

  const content = hypothesis.context?.content as string | undefined;
  if (!content) {
    // No content to check → can't verify → pass (don't penalize absence)
    return { name: 'target-symbol', passed: true, evidence };
  }

  const symbolFound = content.includes(understanding.targetSymbol);
  if (!symbolFound) {
    evidence.push({
      file: hypothesis.target,
      line: 0,
      snippet: `Target symbol '${understanding.targetSymbol}' not found in mutation content`,
    });
    return {
      name: 'target-symbol',
      passed: false,
      evidence,
      reason: `Target symbol '${understanding.targetSymbol}' not present in output`,
    };
  }

  evidence.push({
    file: hypothesis.target,
    line: 0,
    snippet: `Target symbol '${understanding.targetSymbol}' found in mutation content`,
  });
  return { name: 'target-symbol', passed: true, evidence };
}

/**
 * Check 3: Action-verb alignment — verb category maps to expected mutation pattern.
 * Only checks mapped verbs; unknown verbs → pass (don't penalize unknown).
 */
function checkActionVerbAlignment(understanding: TaskUnderstanding, hypothesis: HypothesisTuple): CheckResult {
  const evidence: Evidence[] = [];
  const expectation = VERB_EXPECTATIONS[understanding.actionVerb];

  if (!expectation) {
    // Unknown verb → check not applicable → pass
    return { name: 'action-verb', passed: true, evidence };
  }

  const content = hypothesis.context?.content as string | undefined;
  const hasContent = !!content;

  // For verbs that expect existing files only (refactor, fix, etc.)
  // We can't fully determine "new file" vs "existing file" from HypothesisTuple alone,
  // but we can verify that a mutation task does produce content
  if (expectation.expectsNewFiles && !hasContent && understanding.expectsMutation) {
    evidence.push({
      file: hypothesis.target,
      line: 0,
      snippet: `Verb '${understanding.actionVerb}' expects new files/symbols but no content produced`,
    });
    return {
      name: 'action-verb',
      passed: false,
      evidence,
      reason: `Verb '${understanding.actionVerb}' expects creation but no output`,
    };
  }

  return { name: 'action-verb', passed: true, evidence };
}

/**
 * Check 4: File scope — if the hypothesis target doesn't match any of the
 * understanding's expected files, flag a mismatch.
 * This checks whether the oracle gate is verifying mutations in the expected scope.
 */
function checkFileScope(
  _understanding: TaskUnderstanding,
  hypothesis: HypothesisTuple,
  targetFiles?: string[],
): CheckResult {
  const evidence: Evidence[] = [];

  if (!targetFiles || targetFiles.length === 0) {
    // No target files specified → check not applicable → pass
    return { name: 'file-scope', passed: true, evidence };
  }

  // Check if hypothesis target (the file being verified) overlaps with expected scope
  const target = hypothesis.target;
  const inScope = targetFiles.some(
    (f) =>
      target === f || target.endsWith(`/${f}`) || f.endsWith(`/${target}`) || target.includes(f) || f.includes(target),
  );

  if (!inScope) {
    evidence.push({
      file: target,
      line: 0,
      snippet: `File '${target}' not in expected scope: [${targetFiles.join(', ')}]`,
    });
    return {
      name: 'file-scope',
      passed: false,
      evidence,
      reason: `Mutation target '${target}' outside expected file scope`,
    };
  }

  return { name: 'file-scope', passed: true, evidence };
}

// ── Main verify function ───────────────────────────────────────

export function verify(
  hypothesis: HypothesisTuple,
  understanding?: TaskUnderstanding,
  targetFiles?: string[],
): OracleResponse {
  // No understanding → can't verify goal alignment → abstain
  if (!understanding) {
    const abstention: OracleAbstention = {
      type: 'abstained',
      reason: 'no_understanding',
      oracleName: 'goal-alignment',
      durationMs: 0,
    };
    return abstention;
  }

  const start = performance.now();

  // Run all 4 checks
  const checks: CheckResult[] = [
    checkMutationExpectation(understanding, hypothesis),
    checkTargetSymbolCoverage(understanding, hypothesis),
    checkActionVerbAlignment(understanding, hypothesis),
    checkFileScope(understanding, hypothesis, targetFiles),
  ];

  // Aggregate: all evidence, count passes/fails
  const allEvidence: Evidence[] = checks.flatMap((c) => c.evidence);
  const failedChecks = checks.filter((c) => !c.passed);
  const passedCount = checks.length - failedChecks.length;
  const totalChecks = checks.length;

  // Confidence: proportional to passed checks, capped at heuristic tier max
  const rawConfidence = passedCount / totalChecks;
  const confidence = Math.min(rawConfidence, MAX_CONFIDENCE);

  const verified = failedChecks.length === 0;
  const reasons = failedChecks.map((c) => c.reason).filter(Boolean);
  const durationMs = performance.now() - start;

  return buildVerdict({
    verified,
    type: verified ? 'known' : failedChecks.length === totalChecks ? 'known' : 'uncertain',
    confidence,
    evidence: allEvidence,
    fileHashes: {}, // Goal alignment doesn't verify file content hashes
    reason: reasons.length > 0 ? reasons.join('; ') : undefined,
    oracleName: 'goal-alignment',
    durationMs,
    opinion: fromScalar(confidence, BASE_RATE),
    temporalContext: {
      validFrom: Date.now(),
      validUntil: Date.now() + TTL_MS,
      decayModel: 'exponential',
      halfLife: TTL_MS,
    },
  });
}
