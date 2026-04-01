import { describe, expect, test } from 'bun:test';
import { startMCPServer } from '../../src/cli/mcp.ts';
import { VinyanMCPServer } from '../../src/mcp/server.ts';

describe('MCP CLI entry point', () => {
  test('startMCPServer is importable and is a function', () => {
    expect(typeof startMCPServer).toBe('function');
  });

  test('CLI index includes mcp in usage string', async () => {
    // The CLI index has top-level side effects (switch + process.exit),
    // so we verify the source text directly instead of importing.
    const source = await Bun.file(new URL('../../src/cli/index.ts', import.meta.url).pathname).text();
    expect(source).toContain('mcp');
    expect(source).toContain('Start MCP server over stdio');
  });

  test('VinyanMCPServer instantiates with mock deps and lists 4 tools', () => {
    const mockRunOracle = async () => ({
      verified: true,
      type: 'known' as const,
      confidence: 1.0,
      evidence: [],
      fileHashes: {},
      durationMs: 10,
    });

    const server = new VinyanMCPServer({
      runOracle: mockRunOracle,
      queryFacts: () => [],
    });

    const tools = server.listTools();
    expect(tools).toHaveLength(4);
    expect(tools.map((t) => t.name)).toEqual([
      'vinyan_ast_verify',
      'vinyan_type_check',
      'vinyan_blast_radius',
      'vinyan_query_facts',
    ]);
  });
});
