/**
 * ECPTransport — abstract interface for oracle execution over any transport.
 *
 * Decouples oracle invocation from the transport mechanism:
 * - StdioTransport: child process (current behavior, extracted from runner.ts)
 * - A2ATransport: HTTP POST to peer instance (Phase B2)
 *
 * Source of truth: Plan Phase B1
 */
import type { HypothesisTuple, OracleVerdict } from '../core/types.ts';

export interface ECPTransport {
  /** Execute a hypothesis verification and return the verdict. */
  verify(hypothesis: HypothesisTuple, timeoutMs: number): Promise<OracleVerdict>;
  /** Release any resources held by this transport. */
  close(): Promise<void>;
  /** Transport type identifier — used for confidence clamping (A5). */
  readonly transportType: 'stdio' | 'websocket' | 'http' | 'a2a';
  /** Whether the transport is currently connected and usable. */
  readonly isConnected: boolean;
}
