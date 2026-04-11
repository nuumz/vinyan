/**
 * ECPTransport + StdioTransport tests — Phase B1.
 */
import { describe, expect, test } from 'bun:test';
import { StdioTransport } from '../../src/a2a/stdio-transport.ts';
import type { ECPTransport } from '../../src/a2a/transport.ts';
import type { HypothesisTuple } from '../../src/core/types.ts';

const hypothesis: HypothesisTuple = {
  target: 'test.ts',
  pattern: 'symbol-exists',
  workspace: '/tmp/test',
};

describe('StdioTransport', () => {
  test('implements ECPTransport interface', () => {
    const transport: ECPTransport = new StdioTransport({
      spawnArgs: ['echo', '{}'],
      oracleName: 'test',
    });
    expect(transport.transportType).toBe('stdio');
    expect(transport.isConnected).toBe(true);
  });

  test('returns TIMEOUT verdict when command exceeds timeout', async () => {
    const transport = new StdioTransport({
      spawnArgs: ['sleep', '10'],
      oracleName: 'slow-oracle',
    });

    const verdict = await transport.verify(hypothesis, 100);
    expect(verdict.verified).toBe(false);
    expect(verdict.type).toBe('unknown');
    expect(verdict.errorCode).toBe('TIMEOUT');
    expect(verdict.reason).toContain('timed out');
  });

  test('returns ORACLE_CRASH on non-zero exit', async () => {
    const transport = new StdioTransport({
      spawnArgs: ['false'],
      oracleName: 'crash-oracle',
    });

    const verdict = await transport.verify(hypothesis, 5000);
    expect(verdict.verified).toBe(false);
    expect(verdict.errorCode).toBe('ORACLE_CRASH');
  });

  test('returns PARSE_ERROR on invalid JSON output', async () => {
    const transport = new StdioTransport({
      spawnArgs: ['echo', 'not json'],
      oracleName: 'bad-oracle',
    });

    const verdict = await transport.verify(hypothesis, 5000);
    expect(verdict.verified).toBe(false);
    expect(verdict.errorCode).toBe('PARSE_ERROR');
  });

  test('close() is a no-op for stdio', async () => {
    const transport = new StdioTransport({
      spawnArgs: ['echo', '{}'],
      oracleName: 'test',
    });
    // Should not throw
    await transport.close();
  });
});
