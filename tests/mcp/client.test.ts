/**
 * Tests for K2.5 MCP Client Pool — lifecycle management + verified tool calls.
 */
import { describe, expect, test } from 'bun:test';
import { MCPClientPool, type MCPGate } from '../../src/mcp/client.ts';
import type { OracleVerdict } from '../../src/core/types.ts';

describe('MCPClientPool', () => {
  test('constructor accepts config list', () => {
    const pool = new MCPClientPool([
      { name: 'test-server', command: 'echo hello', trustLevel: 'local' },
    ]);
    expect(pool.size).toBe(0); // not connected yet
  });

  test('listServers returns empty before initialize', () => {
    const pool = new MCPClientPool([
      { name: 'server-a', command: 'echo a', trustLevel: 'local' },
    ]);
    expect(pool.listServers()).toEqual([]);
  });

  test('getClient returns undefined for unknown server', () => {
    const pool = new MCPClientPool([]);
    expect(pool.getClient('nonexistent')).toBeUndefined();
  });

  test('shutdown is safe when no clients connected', async () => {
    const pool = new MCPClientPool([]);
    await pool.shutdown(); // should not throw
    expect(pool.size).toBe(0);
  });

  test('callToolVerified throws for unknown server', async () => {
    const pool = new MCPClientPool([]);
    const mockGate: MCPGate = {
      verify: async () => ({ passed: true, verdicts: {} }),
    };

    await expect(
      pool.callToolVerified('nonexistent', 'tool', {}, mockGate, '/tmp'),
    ).rejects.toThrow("MCP server 'nonexistent' not connected");
  });

  test('G12: callToolVerified interface contract', () => {
    // Verify the interface exists and has correct method signature
    const pool = new MCPClientPool([]);
    expect(typeof pool.callToolVerified).toBe('function');
    expect(typeof pool.initialize).toBe('function');
    expect(typeof pool.shutdown).toBe('function');
    expect(typeof pool.listAllTools).toBe('function');
    expect(typeof pool.getClient).toBe('function');
  });

  test('initialize handles connection failure gracefully', async () => {
    // Use a command that will fail — should not throw
    const pool = new MCPClientPool([
      { name: 'bad-server', command: 'nonexistent-binary-xyz', trustLevel: 'local' },
    ]);

    // Should not throw even with invalid command
    await pool.initialize();
    expect(pool.size).toBe(0);
  });

  test('MCPGate interface accepts verification result', () => {
    // Type-level test: verify the gate interface shape
    const gate: MCPGate = {
      verify: async (_mutations, _workspace) => ({
        passed: true,
        verdicts: {
          'test-oracle': {
            type: 'known' as const,
            verified: true,
            confidence: 0.9,
            evidence: [],
            fileHashes: {},
            durationMs: 0,
          } as OracleVerdict,
        },
      }),
    };
    expect(gate.verify).toBeDefined();
  });
});
