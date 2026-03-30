/**
 * Oracle Gate — the core pipeline that orchestrates guardrails + oracle verification.
 *
 * Input:  GateRequest  (tool name, file path, optional content, workspace)
 * Output: GateVerdict  (allow/block decision with oracle evidence)
 *
 * Pipeline: guardrails → config → oracles → aggregate → verdict
 */
import { createHash } from "crypto";
import { loadConfig } from "../config/loader.ts";
import { detectPromptInjection, containsBypassAttempt } from "../guardrails/index.ts";
import { verify as astVerify } from "../oracle/ast/ast-verifier.ts";
import { verify as typeVerify } from "../oracle/type/type-verifier.ts";
import { verify as depVerify } from "../oracle/dep/dep-analyzer.ts";
import { verify as testVerify } from "../oracle/test/test-verifier.ts";
import { verify as lintVerify } from "../oracle/lint/lint-verifier.ts";
import type { HypothesisTuple, OracleVerdict, QualityScore } from "../core/types.ts";
import { buildVerdict } from "../core/index.ts";
import { logDecision, type SessionLogEntry } from "./logger.ts";
import { isMutatingTool } from "./tool-classifier.ts";
import { computeQualityScore } from "./quality-score.ts";
import type { ComplexityContext, TestContext } from "./quality-score.ts";
import { OracleCircuitBreaker } from "../oracle/circuit-breaker.ts";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

/** Module-level singleton — shared across all gate calls. Resets on process restart. */
const circuitBreaker = new OracleCircuitBreaker();

// ── Public types ────────────────────────────────────────────────

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
}

export type GateDecision = "allow" | "block";

export interface GateVerdict {
  decision: GateDecision;
  reasons: string[];
  oracle_results: Record<string, OracleVerdict>;
  duration_ms: number;
  qualityScore?: QualityScore;
}

// ── Oracle dispatch map ─────────────────────────────────────────

type OracleVerifyFn = (h: HypothesisTuple) => OracleVerdict | Promise<OracleVerdict>;

interface OracleEntry {
  verify: OracleVerifyFn;
  /** Default pattern sent to this oracle when gate is doing a general file check */
  defaultPattern: string;
  /** If true, skip this oracle when no specific pattern/context is provided (e.g. AST needs symbolName) */
  requiresContext: boolean;
}

const ORACLE_ENTRIES: Record<string, OracleEntry> = {
  ast: { verify: astVerify, defaultPattern: "symbol-exists", requiresContext: true },
  type: { verify: typeVerify, defaultPattern: "type-check", requiresContext: false },
  dep: { verify: depVerify, defaultPattern: "dependency-check", requiresContext: false },
  test: { verify: testVerify, defaultPattern: "test-pass", requiresContext: false },
  lint: { verify: lintVerify, defaultPattern: "lint-clean", requiresContext: false },
};

/** Oracles that are informational-only — never block the gate. */
const INFORMATIONAL_ORACLES = new Set(["dep"]);

// ── Gate logic ──────────────────────────────────────────────────

export async function runGate(request: GateRequest): Promise<GateVerdict> {
  const start = performance.now();
  const reasons: string[] = [];
  const oracleResults: Record<string, OracleVerdict> = {};

  // ① Guardrails — scan params for injection / bypass
  const injection = detectPromptInjection(request.params);
  if (injection.detected) {
    reasons.push(`Prompt injection detected: ${injection.patterns.join(", ")}`);
  }

  const bypass = containsBypassAttempt(request.params);
  if (bypass.detected) {
    reasons.push(`Bypass attempt detected: ${bypass.patterns.join(", ")}`);
  }

  if (reasons.length > 0) {
    const verdict: GateVerdict = {
      decision: "block",
      reasons,
      oracle_results: oracleResults,
      duration_ms: performance.now() - start,
    };
    await safeLog(request, verdict);
    return verdict;
  }

  // ①½ Read-only tool short-circuit — skip oracles (no mutation to verify)
  if (!isMutatingTool(request.tool)) {
    const verdict: GateVerdict = {
      decision: "allow",
      reasons: [],
      oracle_results: {},
      duration_ms: performance.now() - start,
    };
    await safeLog(request, verdict);
    return verdict;
  }

  // ② Load config to determine which oracles are enabled
  const config = loadConfig(request.params.workspace);

  // ③ Build hypotheses and run enabled oracles
  const oracleEntries = Object.entries(config.oracles).filter(
    ([name, conf]) => conf.enabled && ORACLE_ENTRIES[name],
  );

  // Run all enabled oracles concurrently (skip context-dependent and circuit-open oracles)
  const results = await Promise.all(
    oracleEntries
      .filter(([name]) => {
        const entry = ORACLE_ENTRIES[name]!;
        if (entry.requiresContext && !request.params.content) return false;
        if (circuitBreaker.shouldSkip(name)) return false; // circuit open → exclude
        return true;
      })
      .map(async ([name]) => {
        const entry = ORACLE_ENTRIES[name]!;
        const oracleConf = config.oracles[name];
        const timeoutMs = oracleConf?.timeout_ms ?? 30_000;
        const timeoutBehavior = oracleConf?.timeout_behavior ?? "block";

        const hypothesis: HypothesisTuple = {
          target: request.params.file_path,
          pattern: entry.defaultPattern,
          context: request.params.content ? { content: request.params.content } : undefined,
          workspace: request.params.workspace,
        };
        try {
          const timeoutPromise = new Promise<"__timeout__">((resolve) =>
            setTimeout(() => resolve("__timeout__"), timeoutMs),
          );
          const raceResult = await Promise.race([entry.verify(hypothesis), timeoutPromise]);

          if (raceResult === "__timeout__") {
            circuitBreaker.recordFailure(name);
            if (timeoutBehavior === "warn") {
              return { name, result: null };
            }
            const timeoutResult: OracleVerdict = buildVerdict({
              verified: false,
              type: "unknown",
              confidence: 0,
              evidence: [],
              fileHashes: {},
              reason: `Oracle "${name}" timed out after ${timeoutMs}ms`,
              errorCode: "TIMEOUT",
              duration_ms: timeoutMs,
            });
            return { name, result: timeoutResult };
          }

          // Record success/failure for circuit breaker
          if (raceResult.errorCode) {
            circuitBreaker.recordFailure(name);
          } else {
            circuitBreaker.recordSuccess(name);
          }

          return { name, result: raceResult };
        } catch (err) {
          circuitBreaker.recordFailure(name);
          const errorResult: OracleVerdict = buildVerdict({
            verified: false,
            type: "unknown",
            confidence: 0,
            evidence: [],
            fileHashes: {},
            reason: `Oracle "${name}" crashed: ${err instanceof Error ? err.message : String(err)}`,
            errorCode: "ORACLE_CRASH",
            duration_ms: 0,
          });
          return { name, result: errorResult };
        }
      }),
  );

  // ④ Aggregate results (skip null — oracle was excluded via timeout_behavior: "warn")
  for (const { name, result } of results) {
    if (!result) continue;
    oracleResults[name] = result;

    if (!result.verified && !INFORMATIONAL_ORACLES.has(name)) {
      reasons.push(`Oracle "${name}" rejected: ${result.reason ?? "no reason given"}`);
    }
  }

  const decision: GateDecision = reasons.length > 0 ? "block" : "allow";
  const duration_ms = performance.now() - start;

  // Build complexity context for QualityScore Phase 1 dimensions
  let complexityContext: ComplexityContext | undefined;
  if (request.params.content && request.params.file_path) {
    try {
      const absPath = resolve(request.params.workspace, request.params.file_path);
      const originalSource = existsSync(absPath) ? readFileSync(absPath, "utf-8") : "";
      complexityContext = { originalSource, mutatedSource: request.params.content };
    } catch {
      // Complexity context is best-effort
    }
  }

  // Build test context from test oracle results
  let testContext: TestContext | undefined;
  if (oracleResults["test"]) {
    testContext = { testsExist: true, testsPassed: oracleResults["test"].verified };
  }

  const verdict: GateVerdict = {
    decision,
    reasons,
    oracle_results: oracleResults,
    duration_ms,
    qualityScore: computeQualityScore(oracleResults, duration_ms, undefined, complexityContext, testContext),
  };

  await safeLog(request, verdict);
  return verdict;
}

// ── Helpers ─────────────────────────────────────────────────────

async function safeLog(request: GateRequest, verdict: GateVerdict): Promise<void> {
  try {
    // Collect blocking verdicts for FP tracking
    const blockedVerdicts =
      verdict.decision === "block"
        ? Object.entries(verdict.oracle_results)
            .filter(([name, v]) => !v.verified && !INFORMATIONAL_ORACLES.has(name))
            .map(([, v]) => v)
        : undefined;

    // Content hash for mutation dedup
    const hashInput = request.params.content ?? request.params.file_path;
    const mutationHash = createHash("sha256").update(hashInput).digest("hex");

    const entry: SessionLogEntry = {
      timestamp: new Date().toISOString(),
      session_id: request.session_id ?? "default",
      tool: request.tool,
      file_path: request.params.file_path,
      decision: verdict.decision,
      reasons: verdict.reasons,
      oracle_results: verdict.oracle_results,
      duration_ms: verdict.duration_ms,
      blocked_verdicts: blockedVerdicts,
      mutation_hash: mutationHash,
    };
    await logDecision(request.params.workspace, entry);
  } catch {
    // Logging failure must not break the gate pipeline
  }
}
