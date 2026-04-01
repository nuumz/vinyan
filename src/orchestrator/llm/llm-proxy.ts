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
import { existsSync, unlinkSync } from 'node:fs';
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

  const server = Bun.listen({
    unix: socketPath,
    socket: {
      async data(socket, rawData) {
        try {
          const text = typeof rawData === 'string' ? rawData : new TextDecoder().decode(rawData);
          // Handle multiple newline-delimited messages in a single data event
          const lines = text.split('\n').filter((l) => l.trim());

          for (const line of lines) {
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
          }
        } catch (err) {
          const errorResponse: LLMProxyResponse = {
            error: `Proxy parse error: ${err instanceof Error ? err.message : String(err)}`,
          };
          socket.write(`${JSON.stringify(errorResponse)}\n`);
        }
      },
      open() {
        /* connection accepted */
      },
      close() {
        /* connection closed */
      },
      error(_socket, error) {
        console.error(`[vinyan] LLM proxy socket error: ${error.message}`);
      },
    },
  });

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
      const proxyRequest: LLMProxyRequest = { tier, llmRequest: request };

      return new Promise((resolve, reject) => {
        const socket = Bun.connect({
          unix: socketPath,
          socket: {
            data(socket, rawData) {
              try {
                const text = typeof rawData === 'string' ? rawData : new TextDecoder().decode(rawData);
                const lines = text.split('\n').filter((l) => l.trim());
                for (const line of lines) {
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
        });

        // Guard against Bun.connect returning void/undefined on connection failure
        if (!socket) {
          reject(new Error(`Failed to connect to LLM proxy at ${socketPath}`));
        }
      });
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
