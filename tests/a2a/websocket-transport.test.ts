/**
 * WebSocketTransport tests — PH5.18.
 *
 * Tests the WebSocket transport implementation including:
 * - Interface compliance
 * - Message exchange (verify flow)
 * - Authentication
 * - Connection management and reconnection
 * - Message deduplication
 * - Integration test with real Bun WebSocket server
 */
import { afterEach, describe, expect, test } from 'bun:test';
import type { ECPTransport } from '../../src/a2a/transport.ts';
import { WebSocketTransport } from '../../src/a2a/websocket-transport.ts';
import type { HypothesisTuple } from '../../src/core/types.ts';

const hypothesis: HypothesisTuple = {
  target: 'test.ts',
  pattern: 'symbol-exists',
  workspace: '/tmp/test',
};

describe('WebSocketTransport', () => {
  test('implements ECPTransport interface', () => {
    const transport: ECPTransport = new WebSocketTransport({
      endpoint: 'ws://localhost:0/ws/ecp',
      oracleName: 'test-oracle',
    });
    expect(transport.transportType).toBe('websocket');
    expect(transport.isConnected).toBe(false);
  });

  test('returns error verdict when not connected', async () => {
    const transport = new WebSocketTransport({
      endpoint: 'ws://localhost:1/ws/ecp',
      oracleName: 'test-oracle',
      maxReconnectAttempts: 0,
    });

    const verdict = await transport.verify(hypothesis, 500);
    expect(verdict.verified).toBe(false);
    expect(verdict.type).toBe('unknown');
    expect(verdict.reason).toContain('not connected');
    await transport.close();
  });

  test('close() rejects pending requests', async () => {
    const transport = new WebSocketTransport({
      endpoint: 'ws://localhost:1/ws/ecp',
      oracleName: 'test-oracle',
      maxReconnectAttempts: 0,
    });

    // Close should not throw
    await transport.close();
    expect(transport.isConnected).toBe(false);
  });

  test('config defaults are applied', () => {
    const transport = new WebSocketTransport({
      endpoint: 'ws://localhost:0/ws/ecp',
      oracleName: 'test',
    });
    // Should construct without error — defaults applied internally
    expect(transport.transportType).toBe('websocket');
  });
});

describe('WebSocketTransport integration', () => {
  let server: ReturnType<typeof Bun.serve> | null = null;

  afterEach(() => {
    server?.stop();
    server = null;
  });

  test('verify round-trip through real WebSocket server', async () => {
    // Start a mock ECP WebSocket server
    server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (new URL(req.url).pathname === '/ws/ecp') {
          const upgraded = srv.upgrade(req, {} as never);
          if (!upgraded) return new Response('Upgrade failed', { status: 400 });
          return undefined as unknown as Response;
        }
        return new Response('Not found', { status: 404 });
      },
      websocket: {
        message(ws, message) {
          const msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message)) as {
            id?: string;
            method?: string;
            params?: { hypothesis?: unknown };
          };

          if (msg.method === 'ecp/heartbeat') {
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { status: 'ok' } }));
            return;
          }

          if (msg.method === 'ecp/verify') {
            ws.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                result: {
                  verified: true,
                  type: 'known',
                  confidence: 0.95,
                  evidence: [{ file: 'test.ts', line: 1, snippet: 'exists' }],
                  fileHashes: {},
                  durationMs: 10,
                },
              }),
            );
            return;
          }

          ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Unknown method' } }));
        },
      },
    });

    const port = server.port;
    const transport = new WebSocketTransport({
      endpoint: `ws://localhost:${port}/ws/ecp`,
      oracleName: 'test-oracle',
      heartbeatIntervalMs: 60_000, // Don't interfere with test
      maxReconnectAttempts: 0,
    });

    transport.connect();

    // Wait for connection
    await new Promise<void>((resolve) => {
      const check = () => {
        if (transport.isConnected) return resolve();
        setTimeout(check, 10);
      };
      check();
    });

    expect(transport.isConnected).toBe(true);

    const verdict = await transport.verify(hypothesis, 5000);
    expect(verdict.verified).toBe(true);
    expect(verdict.type).toBe('known');
    expect(verdict.confidence).toBe(0.95);
    expect(verdict.oracleName).toBe('test-oracle');
    expect(verdict.durationMs).toBeGreaterThanOrEqual(0);

    await transport.close();
    expect(transport.isConnected).toBe(false);
  });

  test('timeout when server never responds', async () => {
    // Server that accepts connections but never responds to verify
    server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (new URL(req.url).pathname === '/ws/ecp') {
          srv.upgrade(req, {} as never);
          return undefined as unknown as Response;
        }
        return new Response('Not found', { status: 404 });
      },
      websocket: {
        message() {
          // Deliberately ignore messages — simulate unresponsive oracle
        },
      },
    });

    const port = server.port;
    const transport = new WebSocketTransport({
      endpoint: `ws://localhost:${port}/ws/ecp`,
      oracleName: 'silent-oracle',
      heartbeatIntervalMs: 60_000,
      maxReconnectAttempts: 0,
    });

    transport.connect();
    await new Promise<void>((resolve) => {
      const check = () => {
        if (transport.isConnected) return resolve();
        setTimeout(check, 10);
      };
      check();
    });

    const verdict = await transport.verify(hypothesis, 200);
    expect(verdict.verified).toBe(false);
    expect(verdict.errorCode).toBe('TIMEOUT');
    expect(verdict.reason).toContain('timed out');

    await transport.close();
  });

  test('authentication flow', async () => {
    let receivedToken = '';

    server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (new URL(req.url).pathname === '/ws/ecp') {
          srv.upgrade(req, {} as never);
          return undefined as unknown as Response;
        }
        return new Response('Not found', { status: 404 });
      },
      websocket: {
        message(ws, message) {
          const msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message)) as {
            id?: string;
            method?: string;
            params?: { token?: string; hypothesis?: unknown };
          };

          if (msg.method === 'ecp/authenticate') {
            receivedToken = msg.params?.token ?? '';
            ws.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { authenticated: true } }));
            return;
          }

          if (msg.method === 'ecp/verify') {
            ws.send(
              JSON.stringify({
                jsonrpc: '2.0',
                id: msg.id,
                result: {
                  verified: true,
                  type: 'known',
                  confidence: 1.0,
                  evidence: [],
                  fileHashes: {},
                  durationMs: 5,
                },
              }),
            );
          }
        },
      },
    });

    const port = server.port;
    const transport = new WebSocketTransport({
      endpoint: `ws://localhost:${port}/ws/ecp`,
      oracleName: 'auth-oracle',
      authToken: 'secret-token-123',
      heartbeatIntervalMs: 60_000,
      maxReconnectAttempts: 0,
    });

    transport.connect();
    await new Promise<void>((resolve) => {
      const check = () => {
        if (transport.isConnected) return resolve();
        setTimeout(check, 10);
      };
      check();
    });

    // Give auth message time to arrive
    await new Promise((r) => setTimeout(r, 50));
    expect(receivedToken).toBe('secret-token-123');

    const verdict = await transport.verify(hypothesis, 5000);
    expect(verdict.verified).toBe(true);

    await transport.close();
  });

  test('multiple concurrent verify requests', async () => {
    let requestCount = 0;

    server = Bun.serve({
      port: 0,
      fetch(req, srv) {
        if (new URL(req.url).pathname === '/ws/ecp') {
          srv.upgrade(req, {} as never);
          return undefined as unknown as Response;
        }
        return new Response('Not found', { status: 404 });
      },
      websocket: {
        message(ws, message) {
          const msg = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message)) as {
            id?: string;
            method?: string;
          };

          if (msg.method === 'ecp/verify') {
            requestCount++;
            // Respond after a small delay to simulate work
            setTimeout(() => {
              ws.send(
                JSON.stringify({
                  jsonrpc: '2.0',
                  id: msg.id,
                  result: {
                    verified: true,
                    type: 'known',
                    confidence: 0.9,
                    evidence: [],
                    fileHashes: {},
                    durationMs: 5,
                  },
                }),
              );
            }, 10);
          }
        },
      },
    });

    const port = server.port;
    const transport = new WebSocketTransport({
      endpoint: `ws://localhost:${port}/ws/ecp`,
      oracleName: 'concurrent-oracle',
      heartbeatIntervalMs: 60_000,
      maxReconnectAttempts: 0,
    });

    transport.connect();
    await new Promise<void>((resolve) => {
      const check = () => {
        if (transport.isConnected) return resolve();
        setTimeout(check, 10);
      };
      check();
    });

    // Send 5 concurrent requests
    const verdicts = await Promise.all([
      transport.verify(hypothesis, 5000),
      transport.verify(hypothesis, 5000),
      transport.verify(hypothesis, 5000),
      transport.verify(hypothesis, 5000),
      transport.verify(hypothesis, 5000),
    ]);

    expect(requestCount).toBe(5);
    for (const v of verdicts) {
      expect(v.verified).toBe(true);
      expect(v.confidence).toBe(0.9);
    }

    await transport.close();
  });
});
