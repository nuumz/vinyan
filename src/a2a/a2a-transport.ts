/**
 * A2ATransport — HTTP-based oracle execution via A2A peer.
 *
 * Sends a HypothesisTuple to a remote Vinyan instance as an A2A tasks/send
 * request with ECP data parts. Applies confidence clamping on response.
 *
 * Also exposes `delegateTask()` for full task-level delegation (Agent
 * Conversation §5.6). That path uses plain text parts so the request is
 * indistinguishable from a normal A2A `tasks/send` call against the
 * peer's bridge — the peer's executeTask runs the task end-to-end and
 * the response is parsed back into a `TaskResult`.
 *
 * Source of truth: Plan Phase B2; Agent Conversation §5.6
 */

import { buildVerdict } from '../core/index.ts';
import type { HypothesisTuple, OracleVerdict } from '../core/types.ts';
import { OracleVerdictSchema } from '../oracle/protocol.ts';
import type { TaskInput, TaskResult } from '../orchestrator/types.ts';
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

  /**
   * Agent Conversation §5.6: send a full task to a peer's A2A bridge for
   * remote execution and parse the result back into a `TaskResult`.
   *
   * Distinct from `verify()`:
   *   - `verify()` sends an ECP data part for an ORACLE call — the peer
   *     answers with a verdict on a hypothesis.
   *   - `delegateTask()` sends a TEXT part with the goal — the peer
   *     runs its full executeTask pipeline and replies with the task
   *     outcome (mutations, status, clarification questions, …).
   *
   * Returns `null` on transport failure or unparseable response so the
   * caller (`InstanceCoordinator`) can transparently fall back to local
   * execution. We deliberately do NOT throw — peer failures should never
   * crash a parent task that has a perfectly good local fallback.
   */
  async delegateTask(input: TaskInput, timeoutMs: number): Promise<TaskResult | null> {
    const { peerUrl } = this.config;
    const taskId = input.id;
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: taskId,
      method: 'tasks/send',
      params: {
        id: taskId,
        message: {
          role: 'user',
          parts: [{ type: 'text', text: input.goal }],
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
      if (!response.ok) {
        this._isConnected = false;
        return null;
      }
      const rpc = (await response.json()) as A2ATasksSendResponse;
      this._isConnected = true;
      return extractTaskResultFromResponse(rpc, taskId, this.config.instanceId);
    } catch {
      clearTimeout(timer);
      this._isConnected = false;
      return null;
    }
  }
}

/**
 * Subset of an A2A JSON-RPC `tasks/send` response that `delegateTask`
 * cares about. Anything else is ignored — a future bridge field that
 * isn't typed here will not break parsing.
 */
interface A2ATasksSendResponse {
  result?: {
    id?: string;
    status?: {
      state?: 'completed' | 'failed' | 'input-required' | string;
      message?: { parts?: Array<{ type?: string; text?: string }> };
    };
    artifacts?: Array<{
      name?: string;
      parts?: Array<{ type?: string; text?: string; data?: unknown }>;
    }>;
  };
}

/**
 * Map an A2A bridge response back into a Vinyan TaskResult. The bridge
 * itself attaches a structured `task_result` data part (see
 * `mapResultToA2ATask`) so the round-trip is mostly lossless. We fall
 * back to a synthesized minimal result if the structured part is absent
 * — a peer that only ever spoke generic A2A still works, but the parent
 * loses access to mutations and oracle verdicts.
 */
function extractTaskResultFromResponse(
  rpc: A2ATasksSendResponse,
  taskId: string,
  sourceInstanceId?: string,
): TaskResult | null {
  const r = rpc.result;
  if (!r) return null;

  // Look for the structured task_result artifact first — this is the
  // happy path when the peer is also a Vinyan instance.
  if (r.artifacts) {
    for (const artifact of r.artifacts) {
      if (artifact.name !== 'task_result') continue;
      for (const part of artifact.parts ?? []) {
        if (part.type === 'data' && part.data && typeof part.data === 'object') {
          const candidate = part.data as Partial<TaskResult>;
          if (candidate.id && candidate.status) {
            return candidate as TaskResult;
          }
        }
      }
    }
  }

  // Fallback: synthesize a minimal TaskResult from the A2A status. This
  // path loses mutations and oracle verdicts but at least surfaces
  // success/failure + clarification questions so the parent can react.
  const stateRaw = r.status?.state ?? 'failed';
  const status: TaskResult['status'] =
    stateRaw === 'completed'
      ? 'completed'
      : stateRaw === 'input-required'
        ? 'input-required'
        : 'failed';

  const messageText = (r.status?.message?.parts ?? [])
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('\n');

  // Naive clarification extraction — the bridge writes "Clarification needed:"
  // as a header followed by "- " bullets. Pull them back out so the parent
  // gets the same `clarificationNeeded` array a local child would produce.
  const clarificationNeeded: string[] = [];
  if (status === 'input-required' && messageText.includes('Clarification needed:')) {
    const after = messageText.split('Clarification needed:')[1] ?? '';
    for (const line of after.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('- ')) clarificationNeeded.push(trimmed.slice(2).trim());
    }
  }

  return {
    id: r.id ?? taskId,
    status,
    mutations: [],
    trace: {
      id: `delegated-${taskId}`,
      taskId,
      timestamp: Date.now(),
      routingLevel: 0,
      approach: 'a2a-remote',
      oracleVerdicts: {},
      modelUsed: 'remote',
      tokensConsumed: 0,
      durationMs: 0,
      outcome: status === 'completed' ? 'success' : 'failure',
      affectedFiles: [],
      sourceInstanceId,
    },
    ...(clarificationNeeded.length > 0 ? { clarificationNeeded } : {}),
  };
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
