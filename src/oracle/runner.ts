import type { HypothesisTuple, OracleVerdict } from "../core/types.ts";
import { buildVerdict } from "../core/index.ts";
import { getOraclePath, getOracleEntry } from "./registry.ts";
import { clampFull, type PeerTrustLevel } from "./tier-clamp.ts";
import type { ECPTransport } from "../a2a/transport.ts";
import { StdioTransport } from "../a2a/stdio-transport.ts";

export interface RunOracleOptions {
  timeout_ms?: number;
  /** Override oracle path (for testing or custom oracles). */
  oraclePath?: string;
  /** Override command (for polyglot oracles — PH5.10). */
  command?: string;
  /** Optional transport override — defaults to StdioTransport. */
  transport?: ECPTransport;
  /** Peer trust level — only applies when transport is A2A. */
  peerTrust?: PeerTrustLevel;
}

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Run an oracle via the configured transport.
 * Default: StdioTransport (child process, stdin/stdout JSON).
 * Phase B2+: A2ATransport (HTTP to remote peer).
 */
export async function runOracle(
  oracleName: string,
  hypothesis: HypothesisTuple,
  options: RunOracleOptions = {},
): Promise<OracleVerdict> {
  const entry = getOracleEntry(oracleName);
  const customCommand = options.command ?? entry?.command;
  const oraclePath = options.oraclePath ?? getOraclePath(oracleName);
  const timeoutMs = options.timeout_ms ?? entry?.timeout_ms ?? DEFAULT_TIMEOUT_MS;

  // Resolve transport: explicit > build from registry/options
  const transport = options.transport ?? resolveStdioTransport(oracleName, customCommand, oraclePath);
  if (!transport) {
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

  const verdict = await transport.verify(hypothesis, timeoutMs);

  // ECP §4.4 (A5): Clamp confidence by tier + transport + peer trust
  const transportType = entry?.transport ?? transport.transportType;
  const clampedConfidence = clampFull(verdict.confidence, entry?.tier, transportType, options.peerTrust);

  // A2: Distinguish genuine epistemic uncertainty from errors.
  if (!verdict.verified && clampedConfidence > 0 && clampedConfidence < 0.5 && verdict.type === "unknown") {
    return { ...verdict, type: "uncertain" as const, confidence: clampedConfidence, oracleName, duration_ms: verdict.duration_ms };
  }

  return { ...verdict, confidence: clampedConfidence, oracleName, duration_ms: verdict.duration_ms };
}

function resolveStdioTransport(
  oracleName: string,
  customCommand: string | undefined,
  oraclePath: string | undefined,
): StdioTransport | null {
  if (!customCommand && !oraclePath) return null;

  const spawnArgs = customCommand
    ? customCommand.split(/\s+/)
    : ["bun", "run", oraclePath!];

  return new StdioTransport({ spawnArgs, oracleName });
}
