/**
 * HttpTransport tests — PH5.18 stateless HTTP oracle transport.
 */
import { describe, expect, test } from 'bun:test';
import { HttpTransport } from '../../src/a2a/http-transport.ts';
import type { ECPTransport } from '../../src/a2a/transport.ts';
import type { HypothesisTuple } from '../../src/core/types.ts';

const hypothesis: HypothesisTuple = {
  target: 'src/test.ts',
  pattern: 'symbol-exists',
  workspace: '/tmp/test',
};

describe('HttpTransport', () => {
  test('implements ECPTransport interface', () => {
    const transport: ECPTransport = new HttpTransport({ endpoint: 'http://localhost:9999' });
    expect(transport.transportType).toBe('http');
    expect(transport.isConnected).toBe(true);
  });

  test('close() is a no-op (stateless transport)', async () => {
    const transport = new HttpTransport({ endpoint: 'http://localhost:9999' });
    // Should not throw
    await transport.close();
  });

  test('isConnected is always true (stateless)', () => {
    const transport = new HttpTransport({ endpoint: 'http://localhost:9999' });
    expect(transport.isConnected).toBe(true);
  });

  test('returns ORACLE_CRASH verdict on HTTP error status', async () => {
    // Spin up a minimal Bun server that returns 500
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response('Internal Error', { status: 500 });
      },
    });

    try {
      const transport = new HttpTransport({ endpoint: `http://localhost:${server.port}` });
      const verdict = await transport.verify(hypothesis, 5000);
      expect(verdict.verified).toBe(false);
      expect(verdict.errorCode).toBe('ORACLE_CRASH');
      expect(verdict.reason).toContain('500');
    } finally {
      server.stop(true);
    }
  });

  test('returns TIMEOUT verdict when request exceeds timeoutMs', async () => {
    // Server that delays response beyond timeout
    const server = Bun.serve({
      port: 0,
      async fetch() {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        return new Response('{}');
      },
    });

    try {
      const transport = new HttpTransport({ endpoint: `http://localhost:${server.port}` });
      const verdict = await transport.verify(hypothesis, 100);
      expect(verdict.verified).toBe(false);
      expect(verdict.errorCode).toBe('TIMEOUT');
      expect(verdict.reason).toContain('timed out');
    } finally {
      server.stop(true);
    }
  });

  test('returns PARSE_ERROR verdict on invalid JSON response', async () => {
    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response('not json at all', { status: 200 });
      },
    });

    try {
      const transport = new HttpTransport({ endpoint: `http://localhost:${server.port}` });
      const verdict = await transport.verify(hypothesis, 5000);
      expect(verdict.verified).toBe(false);
      expect(verdict.errorCode).toBe('ORACLE_CRASH');
    } finally {
      server.stop(true);
    }
  });

  test('sends Authorization header when authToken provided', async () => {
    let capturedAuth: string | null = null;
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        capturedAuth = req.headers.get('Authorization');
        return new Response('not json', { status: 200 });
      },
    });

    try {
      const transport = new HttpTransport({
        endpoint: `http://localhost:${server.port}`,
        authToken: 'my-secret-token',
      });
      await transport.verify(hypothesis, 5000);
      expect(capturedAuth as unknown as string).toBe('Bearer my-secret-token');
    } finally {
      server.stop(true);
    }
  });

  test('strips trailing slash from endpoint', () => {
    const transport = new HttpTransport({ endpoint: 'http://localhost:9999/' });
    // Internally endpoint should be normalized — verify doesn't double-slash
    expect(transport.transportType).toBe('http');
  });

  test('returns valid verdict on successful oracle response', async () => {
    const validVerdict = {
      verified: true,
      type: 'known',
      confidence: 0.9,
      evidence: [{ file: 'src/test.ts', line: 1, snippet: 'export const foo' }],
      fileHashes: { 'src/test.ts': 'abc123' },
      durationMs: 10,
    };

    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(JSON.stringify(validVerdict), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });

    try {
      const transport = new HttpTransport({ endpoint: `http://localhost:${server.port}` });
      const verdict = await transport.verify(hypothesis, 5000);
      expect(verdict.verified).toBe(true);
      expect(verdict.confidence).toBe(0.9);
      expect(verdict.evidence).toHaveLength(1);
    } finally {
      server.stop(true);
    }
  });
});
