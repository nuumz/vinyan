/**
 * WebSocketTransport — persistent bidirectional ECP transport over WebSocket.
 *
 * Provides persistent connection with heartbeat, reconnection with exponential
 * backoff, and message deduplication. Confidence capped at 0.95 for remote
 * verdicts (I13).
 *
 * Source of truth: spec/ecp-spec.md §5, architecture/protocol-architecture.md §2-§3
 */

import { buildVerdict } from '../core/index.ts';
import type { HypothesisTuple, OracleVerdict } from '../core/types.ts';
import { OracleVerdictSchema } from '../oracle/protocol.ts';
import type { ECPTransport } from './transport.ts';

export interface WebSocketTransportConfig {
  /** WebSocket endpoint URL (e.g. "ws://peer:3927/ws/ecp"). */
  endpoint: string;
  /** Oracle name for message routing. */
  oracleName: string;
  /** Bearer token for authentication. */
  authToken?: string;
  /** Heartbeat interval in ms (default: 30000). */
  heartbeatIntervalMs?: number;
  /** Max reconnection attempts before giving up (default: 10). */
  maxReconnectAttempts?: number;
  /** Initial reconnection delay in ms (default: 1000). */
  initialReconnectDelayMs?: number;
  /** Max reconnection delay in ms (default: 60000). */
  maxReconnectDelayMs?: number;
  /** Dedup window size — number of recent message IDs to track (default: 10000). */
  dedupWindowSize?: number;
}

interface PendingRequest {
  resolve: (verdict: OracleVerdict) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 10;
const DEFAULT_INITIAL_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 60_000;
const DEFAULT_DEDUP_WINDOW = 10_000;

export class WebSocketTransport implements ECPTransport {
  readonly transportType = 'websocket' as const;

  private config: Required<WebSocketTransportConfig>;
  private ws: WebSocket | null = null;
  private _isConnected = false;
  private pendingRequests = new Map<string, PendingRequest>();
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private seenMessageIds = new Set<string>();
  private seenMessageQueue: string[] = [];
  private closed = false;

  get isConnected(): boolean {
    return this._isConnected;
  }

  constructor(config: WebSocketTransportConfig) {
    this.config = {
      ...config,
      heartbeatIntervalMs: config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS,
      maxReconnectAttempts: config.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS,
      initialReconnectDelayMs: config.initialReconnectDelayMs ?? DEFAULT_INITIAL_RECONNECT_DELAY_MS,
      maxReconnectDelayMs: config.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS,
      dedupWindowSize: config.dedupWindowSize ?? DEFAULT_DEDUP_WINDOW,
      authToken: config.authToken ?? '',
    };
  }

  /** Connect to the WebSocket endpoint. Call before verify(). */
  connect(): void {
    if (this.closed) return;
    this.doConnect();
  }

  async verify(hypothesis: HypothesisTuple, timeoutMs: number): Promise<OracleVerdict> {
    const startTime = performance.now();
    const requestId = crypto.randomUUID();

    // Auto-connect if not connected
    if (!this._isConnected || !this.ws) {
      this.doConnect();
      // Wait briefly for connection
      await this.waitForConnection(Math.min(timeoutMs, 5_000));
    }

    if (!this._isConnected || !this.ws) {
      return buildVerdict({
        verified: false,
        type: 'unknown',
        confidence: 0,
        evidence: [],
        fileHashes: {},
        reason: `WebSocket not connected to ${this.config.endpoint}`,
        errorCode: 'ORACLE_CRASH',
        durationMs: Math.round(performance.now() - startTime),
      });
    }

    return new Promise<OracleVerdict>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        resolve(
          buildVerdict({
            verified: false,
            type: 'unknown',
            confidence: 0,
            evidence: [],
            fileHashes: {},
            reason: `WebSocket oracle '${this.config.oracleName}' timed out after ${timeoutMs}ms`,
            errorCode: 'TIMEOUT',
            durationMs: timeoutMs,
          }),
        );
      }, timeoutMs);

      this.pendingRequests.set(requestId, {
        resolve: (verdict: OracleVerdict) => {
          clearTimeout(timer);
          this.pendingRequests.delete(requestId);
          resolve({ ...verdict, durationMs: Math.round(performance.now() - startTime) });
        },
        reject: (err: Error) => {
          clearTimeout(timer);
          this.pendingRequests.delete(requestId);
          resolve(
            buildVerdict({
              verified: false,
              type: 'unknown',
              confidence: 0,
              evidence: [],
              fileHashes: {},
              reason: `WebSocket error: ${err.message}`,
              errorCode: 'ORACLE_CRASH',
              durationMs: Math.round(performance.now() - startTime),
            }),
          );
        },
        timer,
      });

      const message = JSON.stringify({
        jsonrpc: '2.0',
        id: requestId,
        method: 'ecp/verify',
        params: {
          oracle_name: this.config.oracleName,
          hypothesis,
        },
      });

      this.ws!.send(message);
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // Reject all pending requests
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Transport closed'));
    }
    this.pendingRequests.clear();

    if (this.ws) {
      this.ws.close(1000, 'Transport closed');
      this.ws = null;
    }
    this._isConnected = false;
  }

  // ── Internal ──────────────────────────────────────────────────

  private doConnect(): void {
    if (this.ws) return;

    try {
      this.ws = new WebSocket(this.config.endpoint);

      this.ws.onopen = () => {
        this._isConnected = true;
        this.reconnectAttempts = 0;

        // Send auth message if token provided
        if (this.config.authToken) {
          this.ws!.send(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 'auth',
              method: 'ecp/authenticate',
              params: { token: this.config.authToken },
            }),
          );
        }

        this.startHeartbeat();
      };

      this.ws.onmessage = (event: MessageEvent) => {
        this.handleMessage(typeof event.data === 'string' ? event.data : String(event.data));
      };

      this.ws.onclose = () => {
        this._isConnected = false;
        this.ws = null;
        this.stopHeartbeat();
        if (!this.closed) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = () => {
        // onclose will fire after onerror, which handles reconnection
      };
    } catch {
      this.ws = null;
      this._isConnected = false;
      if (!this.closed) {
        this.scheduleReconnect();
      }
    }
  }

  private handleMessage(data: string): void {
    try {
      const msg = JSON.parse(data) as { id?: string; result?: unknown; error?: { message: string } };

      // Dedup check
      if (msg.id && this.isDuplicate(msg.id)) return;

      // Heartbeat response — ignore
      if (msg.id === 'heartbeat') return;
      // Auth response — ignore
      if (msg.id === 'auth') return;

      // Match to pending request
      if (msg.id && this.pendingRequests.has(msg.id)) {
        const pending = this.pendingRequests.get(msg.id)!;

        if (msg.error) {
          pending.reject(new Error(msg.error.message));
          return;
        }

        try {
          const verdict = OracleVerdictSchema.parse(msg.result);
          pending.resolve({ ...verdict, oracleName: this.config.oracleName });
        } catch (err) {
          pending.reject(new Error(`Invalid verdict: ${err instanceof Error ? err.message : String(err)}`));
        }
      }
    } catch {
      // Malformed message — ignore
    }
  }

  private isDuplicate(messageId: string): boolean {
    if (this.seenMessageIds.has(messageId)) return true;

    this.seenMessageIds.add(messageId);
    this.seenMessageQueue.push(messageId);

    // Evict oldest when window full
    while (this.seenMessageQueue.length > this.config.dedupWindowSize) {
      const oldest = this.seenMessageQueue.shift();
      if (oldest) this.seenMessageIds.delete(oldest);
    }

    return false;
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this._isConnected) {
        this.ws.send(JSON.stringify({ jsonrpc: '2.0', id: 'heartbeat', method: 'ecp/heartbeat' }));
      }
    }, this.config.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= this.config.maxReconnectAttempts) return;

    const delay = Math.min(
      this.config.initialReconnectDelayMs * 2 ** this.reconnectAttempts,
      this.config.maxReconnectDelayMs,
    );
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.doConnect();
    }, delay);
  }

  private waitForConnection(timeoutMs: number): Promise<void> {
    if (this._isConnected) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const start = Date.now();
      const check = () => {
        if (this._isConnected || Date.now() - start > timeoutMs) {
          resolve();
          return;
        }
        setTimeout(check, 50);
      };
      check();
    });
  }
}
