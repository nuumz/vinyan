/**
 * HttpTransport — stateless HTTP oracle execution via POST /ecp/v1/verify.
 *
 * Implements ECPTransport for calling remote Vinyan oracle endpoints over HTTP.
 * Each verify() is an independent POST request (no persistent connection).
 *
 * Source of truth: spec/implementation-plan.md §PH5.18
 */

import { buildVerdict } from '../core/index.ts';
import type { HypothesisTuple, OracleVerdict } from '../core/types.ts';
import { OracleVerdictSchema } from '../oracle/protocol.ts';
import type { ECPTransport } from './transport.ts';

export interface HttpTransportConfig {
  /** Base URL of the remote Vinyan instance — verifies POSTs to ${endpoint}/ecp/v1/verify */
  endpoint: string;
  /** Optional Bearer token for authenticated remotes. */
  authToken?: string;
}

export class HttpTransport implements ECPTransport {
  readonly transportType = 'http' as const;
  /** Stateless — always considered connected. */
  readonly isConnected = true;

  private readonly endpoint: string;
  private readonly authToken?: string;

  constructor(config: HttpTransportConfig) {
    this.endpoint = config.endpoint.replace(/\/$/, '');
    this.authToken = config.authToken;
  }

  async verify(hypothesis: HypothesisTuple, timeoutMs: number): Promise<OracleVerdict> {
    const startTime = performance.now();
    const url = `${this.endpoint}/ecp/v1/verify`;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(hypothesis),
        signal: AbortSignal.timeout(timeoutMs),
      });

      const durationMs = Math.round(performance.now() - startTime);

      if (!response.ok) {
        return buildVerdict({
          verified: false,
          type: 'unknown',
          confidence: 0,
          evidence: [],
          fileHashes: {},
          reason: `HTTP ${response.status} from remote oracle at ${url}`,
          errorCode: 'ORACLE_CRASH',
          durationMs,
        });
      }

      const raw = await response.json();
      const verdict = OracleVerdictSchema.parse(raw);
      return { ...verdict, durationMs };
    } catch (err) {
      const durationMs = Math.round(performance.now() - startTime);
      const isTimeout = err instanceof Error && err.name === 'TimeoutError';
      return buildVerdict({
        verified: false,
        type: 'unknown',
        confidence: 0,
        evidence: [],
        fileHashes: {},
        reason: isTimeout
          ? `Remote oracle timed out after ${timeoutMs}ms`
          : `HTTP transport error: ${err instanceof Error ? err.message : String(err)}`,
        errorCode: isTimeout ? 'TIMEOUT' : 'ORACLE_CRASH',
        durationMs,
      });
    }
  }

  async close(): Promise<void> {
    // Stateless — no persistent connection to close
  }
}
