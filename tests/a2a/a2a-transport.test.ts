/**
 * A2ATransport tests — Phase B2.
 */
import { describe, expect, test } from 'bun:test';
import { A2ATransport, ECP_MIME_TYPE } from '../../src/a2a/a2a-transport.ts';
import type { ECPTransport } from '../../src/a2a/transport.ts';
import type { HypothesisTuple } from '../../src/core/types.ts';

const hypothesis: HypothesisTuple = {
  target: 'test.ts',
  pattern: 'symbol-exists',
  workspace: '/tmp/test',
};

describe('A2ATransport', () => {
  test('implements ECPTransport interface', () => {
    const transport: ECPTransport = new A2ATransport({
      peerUrl: 'http://localhost:9999',
      oracleName: 'ast-oracle',
    });
    expect(transport.transportType).toBe('a2a');
    expect(transport.connected).toBe(true);
  });

  test('returns error verdict when peer is unreachable', async () => {
    const transport = new A2ATransport({
      peerUrl: 'http://localhost:19999',
      oracleName: 'ast-oracle',
    });

    const verdict = await transport.verify(hypothesis, 2000);
    expect(verdict.verified).toBe(false);
    expect(verdict.type).toBe('unknown');
    expect(verdict.origin).toBe('a2a');
    expect(transport.connected).toBe(false);
  });

  test('returns timeout verdict when peer takes too long', async () => {
    // Start a slow HTTP server
    const server = Bun.serve({
      port: 0,
      async fetch() {
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return new Response('too slow');
      },
    });

    try {
      const transport = new A2ATransport({
        peerUrl: `http://localhost:${server.port}`,
        oracleName: 'ast-oracle',
      });

      const verdict = await transport.verify(hypothesis, 100);
      expect(verdict.verified).toBe(false);
      expect(verdict.errorCode).toBe('TIMEOUT');
      expect(verdict.origin).toBe('a2a');
    } finally {
      server.stop(true);
    }
  });

  test('extracts verdict from valid A2A response', async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as Record<string, any>;
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            id: body.params.id,
            status: { state: 'completed' },
            artifacts: [
              {
                parts: [
                  {
                    type: 'data',
                    data: {
                      verified: true,
                      type: 'known',
                      confidence: 0.95,
                      evidence: [{ file: 'test.ts', line: 1, snippet: 'ok' }],
                      fileHashes: { 'test.ts': 'abc' },
                      durationMs: 50,
                    },
                  },
                ],
              },
            ],
          },
        });
      },
    });

    try {
      const transport = new A2ATransport({
        peerUrl: `http://localhost:${server.port}`,
        oracleName: 'remote-ast',
      });

      const verdict = await transport.verify(hypothesis, 5000);
      expect(verdict.verified).toBe(true);
      expect(verdict.confidence).toBe(0.95);
      expect(verdict.oracleName).toBe('remote-ast');
      expect(verdict.origin).toBe('a2a');
      expect(transport.connected).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test('returns PARSE_ERROR when response has no verdict', async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as Record<string, any>;
        return Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: { id: body.params.id, status: { state: 'completed' } },
        });
      },
    });

    try {
      const transport = new A2ATransport({
        peerUrl: `http://localhost:${server.port}`,
        oracleName: 'no-data',
      });

      const verdict = await transport.verify(hypothesis, 5000);
      expect(verdict.verified).toBe(false);
      expect(verdict.errorCode).toBe('PARSE_ERROR');
    } finally {
      server.stop(true);
    }
  });

  test('close() marks transport as disconnected', async () => {
    const transport = new A2ATransport({
      peerUrl: 'http://localhost:9999',
      oracleName: 'ast-oracle',
    });
    expect(transport.connected).toBe(true);
    await transport.close();
    expect(transport.connected).toBe(false);
  });

  test('ECP_MIME_TYPE is correct', () => {
    expect(ECP_MIME_TYPE).toBe('application/vnd.vinyan.ecp+json');
  });
});
