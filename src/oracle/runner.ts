import { HttpTransport } from '../a2a/http-transport.ts';
import { StdioTransport } from '../a2a/stdio-transport.ts';
import type { ECPTransport } from '../a2a/transport.ts';
import { WebSocketTransport } from '../a2a/websocket-transport.ts';
import { buildVerdict } from '../core/index.ts';
import type { HypothesisTuple, OracleVerdict } from '../core/types.ts';
import { getOracleEntry, getOraclePath } from './registry.ts';
import { clampFull, type PeerTrustLevel } from './tier-clamp.ts';

export interface RunOracleOptions {
  timeoutMs?: number;
  /** Override oracle path (for testing or custom oracles). */
  oraclePath?: string;
  /** Override command (for polyglot oracles — PH5.10). */
  command?: string;
  /** Optional transport override — defaults to StdioTransport. */
  transport?: ECPTransport;
  /** Peer trust level — only applies when transport is A2A. */
  peerTrust?: PeerTrustLevel;
  /** Endpoint URL (for websocket or http transport). */
  endpoint?: string;
  /** Auth token for websocket or http transport. */
  authToken?: string;
  /** Current routing level — used for Safety Invariant I17 enforcement. */
  routingLevel?: number;
  /** Optional bus for emitting safety guardrail events (I17). */
  bus?: { emit(event: string, payload: unknown): void };
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
  const timeoutMs = options.timeoutMs ?? entry?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  // Safety Invariant I17: speculative-tier oracles require L2+ routing isolation (PH5.8).
  // Full enforcement: REJECT (not just warn) when routing level < 2.
  if (entry?.tier === 'speculative' && (options.routingLevel ?? 0) < 2) {
    options.bus?.emit('guardrail:violation', {
      rule: 'I17',
      detail: `Speculative oracle '${oracleName}' rejected at routing level ${options.routingLevel ?? 0} — requires L2+`,
      severity: 'error',
    });
    return buildVerdict({
      verified: false,
      type: 'unknown',
      confidence: 0,
      evidence: [],
      fileHashes: {},
      reason: `I17 violation: speculative oracle '${oracleName}' requires routing level L2+ (current: L${options.routingLevel ?? 0})`,
      errorCode: 'GUARDRAIL_BLOCKED',
      durationMs: 0,
    });
  }

  // Resolve transport: explicit > websocket (from registry) > http > stdio
  const transport = options.transport ?? resolveTransport(oracleName, entry, customCommand, oraclePath, options);
  if (!transport) {
    return buildVerdict({
      verified: false,
      type: 'unknown',
      confidence: 0,
      evidence: [],
      fileHashes: {},
      reason: `Unknown oracle: ${oracleName}`,
      errorCode: 'ORACLE_CRASH',
      durationMs: 0,
    });
  }

  const verdict = await transport.verify(hypothesis, timeoutMs);

  // ECP §4.4 (A5): Clamp confidence by tier + transport + peer trust
  const transportType = entry?.transport ?? transport.transportType;
  const clampedConfidence = clampFull(verdict.confidence, entry?.tier, transportType, options.peerTrust);

  // A2: Distinguish genuine epistemic uncertainty from errors.
  if (!verdict.verified && clampedConfidence > 0 && clampedConfidence < 0.5 && verdict.type === 'unknown') {
    return {
      ...verdict,
      type: 'uncertain' as const,
      confidence: clampedConfidence,
      oracleName,
      durationMs: verdict.durationMs,
    };
  }

  return { ...verdict, confidence: clampedConfidence, oracleName, durationMs: verdict.durationMs };
}

/** Persistent WebSocket transport cache — reuse connections across invocations. */
const wsTransportCache = new Map<string, WebSocketTransport>();

function resolveTransport(
  oracleName: string,
  entry: { transport?: string; command?: string } | undefined,
  customCommand: string | undefined,
  oraclePath: string | undefined,
  options: RunOracleOptions,
): ECPTransport | null {
  const transportType = entry?.transport;

  // WebSocket transport — persistent connection via cache
  if (transportType === 'websocket') {
    const endpoint = options.endpoint ?? (entry as { endpoint?: string })?.endpoint;
    if (!endpoint) return null;

    const cacheKey = `${oracleName}:${endpoint}`;
    let ws = wsTransportCache.get(cacheKey);
    if (!ws || !ws.isConnected) {
      ws = new WebSocketTransport({ endpoint, oracleName, authToken: options.authToken });
      ws.connect();
      wsTransportCache.set(cacheKey, ws);
    }
    return ws;
  }

  // HTTP transport — stateless POST to remote oracle endpoint (PH5.18)
  if (transportType === 'http') {
    const endpoint = options.endpoint ?? (entry as { endpoint?: string })?.endpoint;
    if (!endpoint) return null;
    return new HttpTransport({ endpoint, authToken: options.authToken });
  }

  // Default: stdio transport
  if (!customCommand && !oraclePath) return null;
  const spawnArgs = customCommand ? customCommand.split(/\s+/) : ['bun', 'run', oraclePath!];
  return new StdioTransport({ spawnArgs, oracleName });
}
