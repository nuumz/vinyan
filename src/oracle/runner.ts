import type { HypothesisTuple, OracleVerdict } from "../core/types.ts";
import { buildVerdict } from "../core/index.ts";
import { OracleVerdictSchema } from "./protocol.ts";
import { getOraclePath, getOracleEntry } from "./registry.ts";
import { clampByTier } from "./tier-clamp.ts";

export interface RunOracleOptions {
  timeout_ms?: number;
  /** Override oracle path (for testing or custom oracles). */
  oraclePath?: string;
  /** Override command (for polyglot oracles — PH5.10). */
  command?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Run an oracle as a child process.
 * Writes HypothesisTuple as JSON to stdin, reads OracleVerdict from stdout.
 * Enforces timeout — kills process and returns verified=false on timeout.
 */
export async function runOracle(
  oracleName: string,
  hypothesis: HypothesisTuple,
  options: RunOracleOptions = {},
): Promise<OracleVerdict> {
  // Resolve command: explicit option > registry entry > fallback to path
  const entry = getOracleEntry(oracleName);
  const customCommand = options.command ?? entry?.command;
  const oraclePath = options.oraclePath ?? getOraclePath(oracleName);

  if (!customCommand && !oraclePath) {
    return buildVerdict({
      verified: false,
      type: "unknown",
      confidence: 0,
      evidence: [],
      fileHashes: {},
      reason: `Unknown oracle: ${oracleName}`,
      errorCode: "ORACLE_CRASH",
      duration_ms: 0,
    });
  }

  const timeoutMs = options.timeout_ms ?? entry?.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const startTime = performance.now();

  // PH5.10: Use custom command if available, otherwise default to `bun run <path>`
  const spawnArgs = customCommand
    ? customCommand.split(/\s+/)
    : ["bun", "run", oraclePath!];

  const proc = Bun.spawn(spawnArgs, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  // Write hypothesis to stdin
  const input = JSON.stringify(hypothesis) + "\n";
  proc.stdin.write(input);
  proc.stdin.end();

  // Race between process completion and timeout
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), timeoutMs);
  });

  const processPromise = (async () => {
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;
    return { stdout, exitCode };
  })();

  const result = await Promise.race([processPromise, timeoutPromise]);

  if (result === "timeout") {
    proc.kill();
    return buildVerdict({
      verified: false,
      type: "unknown",
      confidence: 0,
      evidence: [],
      fileHashes: {},
      reason: `Oracle '${oracleName}' timed out after ${timeoutMs}ms`,
      errorCode: "TIMEOUT",
      duration_ms: timeoutMs,
    });
  }

  const duration_ms = Math.round(performance.now() - startTime);

  if (result.exitCode !== 0) {
    return buildVerdict({
      verified: false,
      type: "unknown",
      confidence: 0,
      evidence: [],
      fileHashes: {},
      reason: `Oracle '${oracleName}' exited with code ${result.exitCode}`,
      errorCode: "ORACLE_CRASH",
      duration_ms,
    });
  }

  // Parse and validate the oracle's output
  try {
    const raw = JSON.parse(result.stdout.trim());
    const verdict = OracleVerdictSchema.parse(raw);

    // ECP §4.4 (A5): Clamp confidence by engine trust tier before any downstream use
    const clampedConfidence = clampByTier(verdict.confidence, entry?.tier);

    // A2: Distinguish genuine epistemic uncertainty from errors.
    // If oracle reports low confidence, use 'uncertain' (valid epistemic state)
    // rather than treating it as an error path.
    if (!verdict.verified && clampedConfidence > 0 && clampedConfidence < 0.5 && verdict.type === "unknown") {
      return { ...verdict, type: "uncertain" as const, confidence: clampedConfidence, oracleName, duration_ms };
    }

    return { ...verdict, confidence: clampedConfidence, oracleName, duration_ms };
  } catch (err) {
    return buildVerdict({
      verified: false,
      type: "unknown",
      confidence: 0,
      evidence: [],
      fileHashes: {},
      reason: `Failed to parse oracle output: ${err instanceof Error ? err.message : String(err)}`,
      errorCode: "PARSE_ERROR",
      duration_ms,
    });
  }
}
