/**
 * Oracle Gate — the core pipeline that orchestrates guardrails + oracle verification.
 *
 * Input:  GateRequest  (tool name, file path, optional content, workspace)
 * Output: GateVerdict  (allow/block decision with oracle evidence)
 *
 * Pipeline: guardrails → config → oracles → aggregate → verdict
 */
import { createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { loadConfig } from '../config/loader.ts';
import { buildVerdict } from '../core/index.ts';
import { isAbstention } from '../core/types.ts';
import type { HypothesisTuple, OracleAbstention, OracleResponse, OracleVerdict, QualityScore } from '../core/types.ts';
import { containsBypassAttempt, detectPromptInjection } from '../guardrails/index.ts';
import { verify as astVerify } from '../oracle/ast/ast-verifier.ts';
import { OracleCircuitBreaker } from '../oracle/circuit-breaker.ts';
import { verify as depVerify } from '../oracle/dep/dep-analyzer.ts';
import { verify as lintVerify } from '../oracle/lint/lint-verifier.ts';
import { verify as testVerify } from '../oracle/test/test-verifier.ts';
import { clampByTier } from '../oracle/tier-clamp.ts';
import { verify as typeVerify } from '../oracle/type/type-verifier.ts';
import type { RiskFactors } from '../orchestrator/types.ts';
import type { OracleAccuracyStore } from '../db/oracle-accuracy-store.ts';
import { resolveConflicts } from './conflict-resolver.ts';
import {
  computeAggregateConfidence,
  computeSLAggregate,
  deriveEpistemicDecision,
  generateResolutionHints,
  type EpistemicGateDecision,
  type FusionInput,
  type SLAggregateResult,
  type SubjectiveOpinion,
  fromScalar,
} from './epistemic-decision.ts';
import { logDecision, type SessionLogEntry } from './logger.ts';
import type { ComplexityContext, TestContext } from './quality-score.ts';
import { computeQualityScore } from './quality-score.ts';
import { calculateRiskScore, getIrreversibilityScore, SEALED_ENVIRONMENT } from './risk-router.ts';
import { isMutatingTool } from './tool-classifier.ts';

/** Module-level singleton — shared across all gate calls. Resets on process restart. */
const circuitBreaker = new OracleCircuitBreaker();

/** Module-level oracle accuracy store — injected by factory.ts via setOracleAccuracyStore(). */
let oracleAccuracyStore: OracleAccuracyStore | undefined;

/** Inject the OracleAccuracyStore for accuracy-based conflict resolution. */
export function setOracleAccuracyStore(store: OracleAccuracyStore): void {
  oracleAccuracyStore = store;
}

/**
 * @deprecated Circular accuracy tracking removed — oracle accuracy is now derived
 * from trace-based calibration in SelfModel (Phase 3). Kept as no-op for backward compat.
 */
export function getOracleAccuracy(): Record<string, { total: number; correct: number }> {
  return {};
}

// ── Public types ────────────────────────────────────────────────

// EpistemicGateDecision is re-exported from epistemic-decision.ts
export type { EpistemicGateDecision };

export interface GateRequest {
  /** Agent tool name, e.g. "write_file", "edit_file" */
  tool: string;
  params: {
    /** Relative or absolute path to the target file */
    file_path: string;
    /** File content (for write_file) or patch (for edit_file) */
    content?: string;
    /** Absolute path to workspace root */
    workspace: string;
  };
  /** Session identifier for log grouping — auto-generated if omitted */
  session_id?: string;
  /** Optional — when provided, enables risk-tiered oracle selection (TDD §8). */
  riskScore?: number;
}

export type GateDecision = 'allow' | 'block';

export interface GateVerdict {
  decision: GateDecision;
  reasons: string[];
  oracle_results: Record<string, OracleVerdict>;
  /** Abstaining oracles — excluded from scoring, surfaced for observability. */
  oracle_abstentions?: Record<string, OracleAbstention>;
  /** 4-state epistemic decision (Phase 3 prerequisite). */
  epistemicDecision?: EpistemicGateDecision;
  /** Weighted harmonic mean of oracle confidences. */
  aggregateConfidence?: number;
  /** Actionable hints for uncertainty resolution. */
  caveats?: string[];
  durationMs: number;
  qualityScore?: QualityScore;
  /** Risk score used for oracle tier selection (0.0-1.0). Present when risk-tiered mode is active. */
  riskScore?: number;
  /** Phase 4.9: SL-fused opinion across all oracles. Present when ≥1 oracle ran. */
  fusedOpinion?: SubjectiveOpinion;
}

// ── Oracle dispatch map ─────────────────────────────────────────

type OracleVerifyFn = (h: HypothesisTuple) => OracleResponse | Promise<OracleResponse>;

interface OracleEntry {
  verify: OracleVerifyFn;
  /** Default pattern sent to this oracle when gate is doing a general file check */
  defaultPattern: string;
  /** If true, skip this oracle when no specific pattern/context is provided (e.g. AST needs symbolName) */
  requiresContext: boolean;
}

const ORACLE_ENTRIES: Record<string, OracleEntry> = {
  ast: { verify: astVerify, defaultPattern: 'symbol-exists', requiresContext: true },
  type: { verify: typeVerify, defaultPattern: 'type-check', requiresContext: false },
  dep: { verify: depVerify, defaultPattern: 'dependency-check', requiresContext: false },
  test: { verify: testVerify, defaultPattern: 'test-pass', requiresContext: false },
  lint: { verify: lintVerify, defaultPattern: 'lint-clean', requiresContext: false },
};

/** Oracles that are informational-only — never block the gate. */
const INFORMATIONAL_ORACLES = new Set(['dep']);

/** Oracle tier classification for risk-tiered verification (TDD §8). */
const ORACLE_TIERS: Record<string, 'structural' | 'full'> = {
  ast: 'structural',
  type: 'structural',
  dep: 'structural',
  lint: 'structural',
  test: 'full',
};

// ── Gate logic ──────────────────────────────────────────────────

export async function runGate(request: GateRequest): Promise<GateVerdict> {
  const start = performance.now();
  const reasons: string[] = [];
  const oracleResults: Record<string, OracleVerdict> = {};
  const oracleAbstentions: Record<string, OracleAbstention> = {};

  // ① Guardrails — scan params for injection / bypass
  const injection = detectPromptInjection(request.params);
  if (injection.detected) {
    reasons.push(`Prompt injection detected: ${injection.patterns.join(', ')}`);
  }

  const bypass = containsBypassAttempt(request.params);
  if (bypass.detected) {
    reasons.push(`Bypass attempt detected: ${bypass.patterns.join(', ')}`);
  }

  if (reasons.length > 0) {
    const verdict: GateVerdict = {
      decision: 'block',
      reasons,
      oracle_results: oracleResults,
      oracle_abstentions: oracleAbstentions,
      durationMs: performance.now() - start,
    };
    await safeLog(request, verdict);
    return verdict;
  }

  // ½ Read-only tool short-circuit — skip oracles (no mutation to verify)
  if (!isMutatingTool(request.tool)) {
    const verdict: GateVerdict = {
      decision: 'allow',
      reasons: [],
      oracle_results: {},
      oracle_abstentions: {},
      durationMs: performance.now() - start,
    };
    await safeLog(request, verdict);
    return verdict;
  }

  // ② Risk assessment — determines oracle tier when riskScore provided (TDD §8)
  let riskScore: number | undefined;
  if (request.riskScore != null) {
    riskScore = request.riskScore;
  } else {
    // Compute lightweight risk score from tool name for observability
    const irreversibility = getIrreversibilityScore(request.tool);
    const riskFactors: RiskFactors = {
      blastRadius: 1,
      dependencyDepth: 0,
      testCoverage: 0.5,
      fileVolatility: 0,
      irreversibility,
      hasSecurityImplication: false,
      environmentType: SEALED_ENVIRONMENT,
    };
    riskScore = calculateRiskScore(riskFactors);
  }

  // ②½ Load config to determine which oracles are enabled
  const config = loadConfig(request.params.workspace);

  // ③ Build hypotheses and run enabled oracles
  const oracleEntries = Object.entries(config.oracles).filter(([name, conf]) => conf.enabled && ORACLE_ENTRIES[name]);

  // Run all enabled oracles concurrently (skip context-dependent, circuit-open, and risk-excluded oracles)
  const riskTieringActive = request.riskScore != null;
  const results = await Promise.all(
    oracleEntries
      .filter(([name]) => {
        const entry = ORACLE_ENTRIES[name]!;
        if (entry.requiresContext && !request.params.content) return false;
        if (circuitBreaker.shouldSkip(name)) return false; // circuit open → exclude
        // Risk-tiered filtering (TDD §8) — only when explicitly opted in
        if (riskTieringActive && riskScore != null) {
          const tier = ORACLE_TIERS[name] ?? 'structural';
          if (riskScore < 0.2) return false; // hash-only → skip all oracles
          if (riskScore < 0.4 && tier === 'full') return false; // structural → skip test oracle
        }
        return true;
      })
      .map(async ([name]) => {
        const entry = ORACLE_ENTRIES[name]!;
        const oracleConf = config.oracles[name];
        const timeoutMs = oracleConf?.timeout_ms ?? 30_000;
        const timeoutBehavior = oracleConf?.timeout_behavior ?? 'block';

        const hypothesis: HypothesisTuple = {
          target: request.params.file_path,
          pattern: entry.defaultPattern,
          context: request.params.content ? { content: request.params.content } : undefined,
          workspace: request.params.workspace,
        };
        try {
          const timeoutPromise = new Promise<'__timeout__'>((resolve) =>
            setTimeout(() => resolve('__timeout__'), timeoutMs),
          );
          const raceResult = await Promise.race([entry.verify(hypothesis), timeoutPromise]);

          if (raceResult === '__timeout__') {
            circuitBreaker.recordFailure(name);
            if (timeoutBehavior === 'warn') {
              return { name, result: null };
            }
            const timeoutResult: OracleVerdict = buildVerdict({
              verified: false,
              type: 'unknown',
              confidence: 0,
              evidence: [],
              fileHashes: {},
              reason: `Oracle "${name}" timed out after ${timeoutMs}ms`,
              errorCode: 'TIMEOUT',
              durationMs: timeoutMs,
            });
            return { name, result: timeoutResult };
          }

          // If oracle abstained (e.g., no test files, no linter configured), return without clamping.
          if (isAbstention(raceResult)) {
            return { name, result: raceResult };
          }

          // Record success/failure for circuit breaker
          if (raceResult.errorCode) {
            circuitBreaker.recordFailure(name);
          } else {
            circuitBreaker.recordSuccess(name);
          }

          // ECP §4.4 (A5): Clamp confidence by oracle trust tier
          const oracleTier = config.oracles[name]?.tier ?? 'deterministic';
          const clampedResult = { ...raceResult, confidence: clampByTier(raceResult.confidence, oracleTier) };
          return { name, result: clampedResult };
        } catch (err) {
          circuitBreaker.recordFailure(name);
          const errorResult: OracleVerdict = buildVerdict({
            verified: false,
            type: 'unknown',
            confidence: 0,
            evidence: [],
            fileHashes: {},
            reason: `Oracle "${name}" crashed: ${err instanceof Error ? err.message : String(err)}`,
            errorCode: 'ORACLE_CRASH',
            durationMs: 0,
          });
          return { name, result: errorResult };
        }
      }),
  );

  // ⑤ Collect results — partition into verdicts vs abstentions
  // (skip null — oracle was excluded via timeout_behavior: "warn")
  for (const { name, result } of results) {
    if (!result) continue;
    if (isAbstention(result)) {
      oracleAbstentions[name] = result;
    } else {
      oracleResults[name] = result;
    }
  }

  // ④½ Resolve conflicts via 5-step deterministic tree (concept §3.2, A5)
  // Build accuracy map from store for accuracy-based tiebreaking in ambiguous K zone
  let oracleAccuracy: Record<string, { total: number; correct: number }> | undefined;
  if (oracleAccuracyStore) {
    const accuracyMap: Record<string, { total: number; correct: number }> = {};
    for (const name of Object.keys(oracleResults)) {
      const stats = oracleAccuracyStore.computeOracleAccuracy(name, 30);
      // Use resolved count only (correct + wrong) — pending verdicts should not inflate denominator
      const resolvedTotal = stats.correct + stats.wrong;
      if (resolvedTotal > 0) {
        accuracyMap[name] = { total: resolvedTotal, correct: stats.correct };
      }
    }
    if (Object.keys(accuracyMap).length > 0) {
      oracleAccuracy = accuracyMap;
    }
  }

  const resolved = resolveConflicts(oracleResults, {
    oracleTiers: Object.fromEntries(
      Object.entries(config.oracles).map(([name, conf]) => [name, conf.tier ?? 'deterministic']),
    ),
    informationalOracles: INFORMATIONAL_ORACLES,
    oracleAccuracy,
  }, oracleAbstentions);
  reasons.push(...resolved.reasons);

  // Compute aggregate confidence (weighted harmonic mean across oracle tiers)
  const oracleTiersForConfidence: Record<string, string> = Object.fromEntries(
    Object.entries(config.oracles).map(([name, conf]) => [name, conf.tier ?? 'heuristic']),
  );

  // Phase 4.9: Build SL fusion inputs from oracle results (direction-aware opinion, tier, evidence files as deps)
  const fusionInputs: FusionInput[] = Object.entries(oracleResults).map(([name, verdict]) => ({
    opinion: verdict.opinion != null
      ? verdict.opinion
      : (verdict.verified ? fromScalar(verdict.confidence) : fromScalar(1 - verdict.confidence)),
    tier: oracleTiersForConfidence[name] ?? 'heuristic',
    deps: verdict.evidence.map(e => e.file),
  }));
  const slResult: SLAggregateResult = computeSLAggregate(fusionInputs);

  // Use SL aggregate when available; harmonic mean as NaN/empty fallback
  const aggregateConfidence = !Number.isNaN(slResult.confidence)
    ? slResult.confidence
    : computeAggregateConfidence(oracleResults, oracleTiersForConfidence);
  // "All abstained" means oracles were dispatched but all returned abstentions (no verdicts).
  // Empty oracleResults + empty oracleAbstentions = no oracles ran (deliberate skip, not abstention).
  const hasAllAbstained = Object.keys(oracleResults).length === 0 && Object.keys(oracleAbstentions).length > 0;
  const epistemicDecision = deriveEpistemicDecision(aggregateConfidence, hasAllAbstained);

  // Backward-compat: map epistemic decision to binary allow/block
  // When no oracles ran at all (e.g., L0 hash-only risk tier), fall back to reasons-only decision.
  const noOraclesDispatched = Object.keys(oracleResults).length === 0 && Object.keys(oracleAbstentions).length === 0;
  const decision: GateDecision = reasons.length > 0
    ? 'block'
    : noOraclesDispatched
      ? 'allow'
      : (epistemicDecision === 'allow' || epistemicDecision === 'allow-with-caveats') ? 'allow' : 'block';

  // Generate caveats for non-clean passes
  const abstentionReasons = Object.values(oracleAbstentions).map(a => a.reason);
  const caveats = epistemicDecision !== 'allow'
    ? generateResolutionHints(abstentionReasons, aggregateConfidence).map(h => h as string)
    : [];

  const durationMs = performance.now() - start;

  // Build complexity context for QualityScore Phase 1 dimensions
  let complexityContext: ComplexityContext | undefined;
  if (request.params.content && request.params.file_path) {
    try {
      const absPath = resolve(request.params.workspace, request.params.file_path);
      const originalSource = existsSync(absPath) ? readFileSync(absPath, 'utf-8') : '';
      complexityContext = { originalSource, mutatedSource: request.params.content };
    } catch {
      // Complexity context is best-effort
    }
  }

  // Build test context from test oracle results
  let testContext: TestContext | undefined;
  if (oracleResults['test']) {
    testContext = { testsExist: true, testsPassed: oracleResults['test'].verified };
  }

  // Build oracle tier map from config for A5 tier-weighted quality scoring
  const oracleTiers: Record<string, string> = {};
  for (const [name, conf] of Object.entries(config.oracles)) {
    oracleTiers[name] = conf.tier ?? 'deterministic';
  }

  const verdict: GateVerdict = {
    decision,
    reasons,
    oracle_results: oracleResults,
    oracle_abstentions: oracleAbstentions,
    epistemicDecision,
    aggregateConfidence,
    caveats: caveats.length > 0 ? caveats : undefined,
    durationMs,
    qualityScore: computeQualityScore(
      oracleResults,
      durationMs,
      undefined,
      complexityContext,
      testContext,
      oracleTiers,
      slResult.fusedOpinion != null ? slResult.confidence : undefined,
    ),
    riskScore,
    fusedOpinion: slResult.fusedOpinion ?? undefined,
  };

  await safeLog(request, verdict);
  return verdict;
}

// ── Helpers ─────────────────────────────────────────────────────

async function safeLog(request: GateRequest, verdict: GateVerdict): Promise<void> {
  try {
    // Collect blocking verdicts for FP tracking
    const blockedVerdicts =
      verdict.decision === 'block'
        ? Object.entries(verdict.oracle_results)
            .filter(([name, v]) => !v.verified && !INFORMATIONAL_ORACLES.has(name))
            .map(([, v]) => v)
        : undefined;

    // Content hash for mutation dedup
    const hashInput = request.params.content ?? request.params.file_path;
    const mutationHash = createHash('sha256').update(hashInput).digest('hex');

    const entry: SessionLogEntry = {
      timestamp: new Date().toISOString(),
      session_id: request.session_id ?? 'default',
      tool: request.tool,
      file_path: request.params.file_path,
      decision: verdict.decision,
      reasons: verdict.reasons,
      oracle_results: verdict.oracle_results,
      durationMs: verdict.durationMs,
      blocked_verdicts: blockedVerdicts,
      mutation_hash: mutationHash,
    };
    await logDecision(request.params.workspace, entry);
  } catch {
    // Logging failure must not break the gate pipeline
  }
}
