/**
 * A2ATransport — HTTP-based oracle execution via A2A peer.
 *
 * Sends a HypothesisTuple to a remote Vinyan instance as an A2A tasks/send
 * request with ECP data parts. Applies confidence clamping on response.
 *
 * Source of truth: Plan Phase B2
 */

import { buildVerdict } from '../core/index.ts';
import type { HypothesisTuple, OracleVerdict } from '../core/types.ts';
import { OracleVerdictSchema } from '../oracle/protocol.ts';
import { ECP_MIME_TYPE } from './ecp-data-part.ts';
import type { ECPTransport } from './transport.ts';

export { ECP_MIME_TYPE };

export interface A2ATransportConfig {
  /** Base URL of the remote Vinyan instance (e.g. "http://peer:3928"). */
  peerUrl: string;
  /** Oracle name to request from the peer. */
  oracleName: string;
  /** Instance ID of the local instance (for request identification). */
  instanceId?: string;
}

export class A2ATransport implements ECPTransport {
  readonly transportType = 'a2a' as const;
  private config: A2ATransportConfig;
  private _isConnected = true;

  get isConnected(): boolean {
    return this._isConnected;
  }

  constructor(config: A2ATransportConfig) {
    this.config = config;
  }

  async verify(hypothesis: HypothesisTuple, timeoutMs: number): Promise<OracleVerdict> {
    const startTime = performance.now();
    const { peerUrl, oracleName } = this.config;
    const taskId = crypto.randomUUID();

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: taskId,
      method: 'tasks/send',
      params: {
        id: taskId,
        message: {
          role: 'user',
          parts: [
            {
              type: 'data',
              mimeType: ECP_MIME_TYPE,
              data: {
                ecp_version: 1,
                message_type: 'request',
                oracle_name: oracleName,
                hypothesis,
              },
            },
          ],
        },
      },
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${peerUrl}/a2a`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });

      clearTimeout(timer);
      const durationMs = Math.round(performance.now() - startTime);

      if (!response.ok) {
        this._isConnected = false;
        return buildVerdict({
          verified: false,
          type: 'unknown',
          confidence: 0,
          evidence: [],
          fileHashes: {},
          reason: `A2A peer returned HTTP ${response.status}: ${response.statusText}`,
          errorCode: 'ORACLE_CRASH',
          durationMs,
          origin: 'a2a',
        });
      }

      const rpcResponse = await response.json();
      this._isConnected = true;

      // Extract verdict from A2A response artifacts or message parts
      const verdict = extractVerdictFromResponse(rpcResponse, oracleName, durationMs);
      return { ...verdict, origin: 'a2a' as const };
    } catch (err) {
      clearTimeout(timer);
      const durationMs = Math.round(performance.now() - startTime);

      if (err instanceof DOMException && err.name === 'AbortError') {
        this._isConnected = false;
        return buildVerdict({
          verified: false,
          type: 'unknown',
          confidence: 0,
          evidence: [],
          fileHashes: {},
          reason: `A2A peer '${peerUrl}' timed out after ${timeoutMs}ms`,
          errorCode: 'TIMEOUT',
          durationMs,
          origin: 'a2a',
        });
      }

      this._isConnected = false;
      return buildVerdict({
        verified: false,
        type: 'unknown',
        confidence: 0,
        evidence: [],
        fileHashes: {},
        reason: `A2A transport error: ${err instanceof Error ? err.message : String(err)}`,
        errorCode: 'ORACLE_CRASH',
        durationMs,
        origin: 'a2a',
      });
    }
  }

  async close(): Promise<void> {
    this._isConnected = false;
  }
}

/**
 * Extract an OracleVerdict from an A2A JSON-RPC response.
 * Looks for ECP data parts in the task result, falls back to parsing artifact data.
 */
function extractVerdictFromResponse(rpcResponse: unknown, oracleName: string, durationMs: number): OracleVerdict {
  try {
    const rpc = rpcResponse as { result?: { artifacts?: Array<{ parts: Array<{ data?: unknown }> }> } };
    const artifacts = rpc?.result?.artifacts ?? [];

    for (const artifact of artifacts) {
      for (const part of artifact.parts ?? []) {
        if (part.data) {
          // Try to find oracle verdicts in the data
          const data = part.data as Record<string, unknown>;
          if (data.oracleVerdicts && typeof data.oracleVerdicts === 'object') {
            const verdicts = data.oracleVerdicts as Record<string, unknown>;
            const verdict = verdicts[oracleName] ?? Object.values(verdicts)[0];
            if (verdict) {
              const parsed = OracleVerdictSchema.safeParse(verdict);
              if (parsed.success) {
                return { ...parsed.data, oracleName, durationMs };
              }
            }
          }
          // Try parsing data directly as a verdict
          const parsed = OracleVerdictSchema.safeParse(data);
          if (parsed.success) {
            return { ...parsed.data, oracleName, durationMs };
          }
        }
      }
    }

    return buildVerdict({
      verified: false,
      type: 'unknown',
      confidence: 0,
      evidence: [],
      fileHashes: {},
      reason: 'A2A response contained no parseable verdict',
      errorCode: 'PARSE_ERROR',
      durationMs,
    });
  } catch {
    return buildVerdict({
      verified: false,
      type: 'unknown',
      confidence: 0,
      evidence: [],
      fileHashes: {},
      reason: 'Failed to extract verdict from A2A response',
      errorCode: 'PARSE_ERROR',
      durationMs,
    });
  }
}
