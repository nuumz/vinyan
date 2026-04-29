/**
 * LLM Proxy Server — credential isolation for worker subprocesses (A6).
 *
 * The orchestrator holds API credentials and runs a Unix domain socket server.
 * Worker subprocesses send LLM requests through the socket without ever seeing
 * raw API keys. This enforces A6: workers propose, orchestrator disposes.
 *
 * Transport: Unix domain socket (no network exposure).
 * Protocol: newline-delimited JSON (request → response).
 *
 * Feature-flagged: enabled via OrchestratorConfig.llmProxy = true.
 */
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LLMProvider, LLMRequest, LLMResponse } from '../types.ts';
import type { LLMProviderRegistry } from './provider-registry.ts';

export interface LLMProxyServer {
  socketPath: string;
  close(): void;
}

/**
 * Start a Unix domain socket server that proxies LLM requests using the
 * orchestrator's provider registry. Workers connect and send JSON requests;
 * the proxy forwards to the appropriate provider and returns the response.
 */
export function startLLMProxy(registry: LLMProviderRegistry): LLMProxyServer {
  const socketPath = join(tmpdir(), `vinyan-llm-proxy-${process.pid}-${Date.now()}.sock`);

  // Clean up stale socket file if it exists
  try {
    if (existsSync(socketPath)) unlinkSync(socketPath);
  } catch {
    /* ignore */
  }

  // Per-connection buffer for newline-delimited JSON framing (handles TCP chunking)
  const socketBuffers = new WeakMap<object, string>();

  const server = Bun.listen({
    unix: socketPath,
    socket: {
      async data(socket, rawData) {
        // Accumulate data in per-connection buffer to handle TCP chunking
        const prev = socketBuffers.get(socket) ?? '';
        const text = prev + (typeof rawData === 'string' ? rawData : new TextDecoder().decode(rawData));

        // Split into lines; last element may be incomplete
        const parts = text.split('\n');
        // Keep incomplete trailing part in buffer
        socketBuffers.set(socket, parts.pop()!);

        for (const line of parts) {
          if (!line.trim()) continue;
          try {
            const request = JSON.parse(line) as LLMProxyRequest;

            // Select provider by tier (matching worker-entry.ts logic)
            const provider = request.tier
              ? registry.selectByTier(request.tier)
              : registry.selectForRoutingLevel((request.routingLevel ?? 1) as import('../types.ts').RoutingLevel);

            if (!provider) {
              const errorResponse: LLMProxyResponse = {
                error: 'No provider available',
              };
              socket.write(`${JSON.stringify(errorResponse)}\n`);
              continue;
            }

            try {
              const llmResponse = await provider.generate(request.llmRequest);
              const proxyResponse: LLMProxyResponse = { response: llmResponse };
              socket.write(`${JSON.stringify(proxyResponse)}\n`);
            } catch (err) {
              const errorResponse: LLMProxyResponse = {
                error: err instanceof Error ? err.message : String(err),
              };
              socket.write(`${JSON.stringify(errorResponse)}\n`);
            }
          } catch (err) {
            const errorResponse: LLMProxyResponse = {
              error: `Proxy parse error: ${err instanceof Error ? err.message : String(err)}`,
            };
            socket.write(`${JSON.stringify(errorResponse)}\n`);
          }
        }
      },
      open() {
        /* connection accepted */
      },
      close(socket) {
        socketBuffers.delete(socket);
      },
      error(_socket, error) {
        console.error(`[vinyan] LLM proxy socket error: ${error.message}`);
      },
    },
  });

  // Restrict socket permissions to owner only (A6: credential isolation)
  try {
    chmodSync(socketPath, 0o600);
  } catch {
    /* best-effort — tmpdir may not support chmod */
  }

  return {
    socketPath,
    close() {
      server.stop(true);
      try {
        if (existsSync(socketPath)) unlinkSync(socketPath);
      } catch {
        /* ignore */
      }
    },
  };
}

/**
 * Create an LLMProvider that proxies requests through a Unix domain socket
 * to the orchestrator's LLM proxy server. Used by worker subprocesses.
 */
export function createProxyProvider(socketPath: string, tier: LLMProvider['tier'] = 'balanced'): LLMProvider {
  return {
    id: `proxy/${tier}`,
    tier,
    async generate(request: LLMRequest): Promise<LLMResponse> {
      // IPC-layer ceiling for the worker → orchestrator → provider round-trip.
      // The provider itself honors `request.timeoutMs` for the actual HTTP call;
      // this socket timeout is a belt-and-suspenders safety net so a wedged
      // provider can't pin a worker forever.
      //
      // Why budget-aware: the prior fixed 65s was below Claude Sonnet's
      // realistic ceiling for analytical work — observed in the wild as
      // "LLM proxy timeout after 65000ms" on long-running workflow steps
      // even when the provider call itself had a higher timeout. The fix
      // is to derive the IPC timeout from the request's own budget plus
      // headroom for socket roundtrip + server-side queuing.
      //
      //   - Floor (120s): minimum cushion for a realistic Sonnet call
      //   - Headroom (+15s): added to request.timeoutMs to cover IPC overhead
      //   - Ceiling (600s): hard upper bound to keep wedged calls bounded
      const PROXY_HEADROOM_MS = 15_000;
      const PROXY_TIMEOUT_FLOOR_MS = 120_000;
      const PROXY_TIMEOUT_CEILING_MS = 600_000;
      const requestTimeoutMs = request.timeoutMs ?? 0;
      const PROXY_TIMEOUT_MS = Math.min(
        PROXY_TIMEOUT_CEILING_MS,
        Math.max(PROXY_TIMEOUT_FLOOR_MS, requestTimeoutMs + PROXY_HEADROOM_MS),
      );
      const proxyRequest: LLMProxyRequest = { tier, llmRequest: request };

      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      let resolvedSocket: { end(): void } | undefined;

      try {
        const socketPromise = new Promise<LLMResponse>((resolve, reject) => {
          let buffer = '';
          Bun.connect({
            unix: socketPath,
            socket: {
              data(socket, rawData) {
                try {
                  buffer += typeof rawData === 'string' ? rawData : new TextDecoder().decode(rawData);
                  const parts = buffer.split('\n');
                  buffer = parts.pop()!; // keep incomplete trailing part
                  for (const line of parts) {
                    if (!line.trim()) continue;
                    const parsed = JSON.parse(line) as LLMProxyResponse;
                    if (parsed.error) {
                      reject(new Error(parsed.error));
                    } else if (parsed.response) {
                      resolve(parsed.response);
                    }
                    socket.end();
                  }
                } catch (err) {
                  reject(err);
                }
              },
              open(socket) {
                resolvedSocket = socket;
                socket.write(`${JSON.stringify(proxyRequest)}\n`);
              },
              error(_socket, error) {
                reject(error);
              },
              close() {
                /* cleanup */
              },
              connectError(_socket, error) {
                reject(error);
              },
            },
          }).catch(reject);
        });

        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutTimer = setTimeout(
            () => reject(new Error(`LLM proxy timeout after ${PROXY_TIMEOUT_MS}ms`)),
            PROXY_TIMEOUT_MS,
          );
        });

        return await Promise.race([socketPromise, timeoutPromise]);
      } finally {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        try { resolvedSocket?.end(); } catch { /* already closed */ }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Wire types
// ---------------------------------------------------------------------------

interface LLMProxyRequest {
  tier?: LLMProvider['tier'];
  routingLevel?: number;
  llmRequest: LLMRequest;
}

interface LLMProxyResponse {
  response?: LLMResponse;
  error?: string;
}
