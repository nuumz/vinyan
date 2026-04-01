import { describe, expect, test } from 'bun:test';
import { buildVerdict } from '../../src/core/index.ts';
import type { Fact, HypothesisTuple, OracleVerdict } from '../../src/core/types.ts';
import { VinyanMCPServer } from '../../src/mcp/server.ts';

// ── Test helpers ────────────────────────────────────────────────────

function makeOracle() {
  const calls: Array<{ name: string; hypothesis: HypothesisTuple }> = [];
  return {
    calls,
    runOracle: async (name: string, hypothesis: HypothesisTuple): Promise<OracleVerdict> => {
      calls.push({ name, hypothesis });
      return buildVerdict({
        verified: true,
        evidence: [{ file: hypothesis.target, line: 1, snippet: `${name} ok` }],
        fileHashes: { [hypothesis.target]: 'test-hash' },
        oracleName: name,
        durationMs: 5,
      });
    },
  };
}

const mockFacts: Fact[] = [
  {
    id: 'fact-1',
    target: 'src/app.ts',
    pattern: 'symbol-exists',
    evidence: [{ file: 'src/app.ts', line: 1, snippet: 'export class App {}' }],
    oracleName: 'ast',
    fileHash: 'abc',
    sourceFile: 'src/app.ts',
    verifiedAt: Date.now(),
    confidence: 1.0,
  },
];

function makeServer(overrides?: Partial<ConstructorParameters<typeof VinyanMCPServer>[0]>) {
  const oracle = makeOracle();
  const server = new VinyanMCPServer({
    runOracle: oracle.runOracle,
    queryFacts: (target: string) => mockFacts.filter((f) => f.target === target),
    ...overrides,
  });
  return { server, oracle };
}

function makeToolCallRequest(toolName: string, args: Record<string, unknown>, id: number = 1) {
  return {
    jsonrpc: '2.0' as const,
    id,
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  };
}

const validHypothesis = {
  target: 'src/app.ts',
  pattern: 'symbol-exists',
  workspace: '/tmp/test',
};

// ── tools/list ──────────────────────────────────────────────────────

describe('tools/list', () => {
  test('returns 4 tools', async () => {
    const { server } = makeServer();
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });

    expect(response.error).toBeUndefined();
    const result = response.result as { tools: unknown[] };
    expect(result.tools).toHaveLength(4);
  });

  test('each tool has correct name and inputSchema', async () => {
    const { server } = makeServer();
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });

    const tools = (response.result as { tools: Array<{ name: string; inputSchema: Record<string, unknown> }> }).tools;
    const names = tools.map((t) => t.name);

    expect(names).toContain('vinyan_ast_verify');
    expect(names).toContain('vinyan_type_check');
    expect(names).toContain('vinyan_blast_radius');
    expect(names).toContain('vinyan_query_facts');

    for (const tool of tools) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.inputSchema.type).toBe('object');
    }
  });
});

// ── Oracle tool calls ───────────────────────────────────────────────

describe('vinyan_ast_verify', () => {
  test('calls ast oracle correctly', async () => {
    const { server, oracle } = makeServer();
    const response = await server.handleRequest(makeToolCallRequest('vinyan_ast_verify', validHypothesis));

    expect(response.error).toBeUndefined();
    expect(oracle.calls).toHaveLength(1);
    expect(oracle.calls[0]!.name).toBe('ast');
    expect(oracle.calls[0]!.hypothesis.target).toBe('src/app.ts');

    const result = response.result as { content: Array<{ text: string }> };
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.verified).toBe(true);
  });
});

describe('vinyan_type_check', () => {
  test('calls type oracle correctly', async () => {
    const { server, oracle } = makeServer();
    const response = await server.handleRequest(makeToolCallRequest('vinyan_type_check', validHypothesis));

    expect(response.error).toBeUndefined();
    expect(oracle.calls).toHaveLength(1);
    expect(oracle.calls[0]!.name).toBe('type');
  });
});

describe('vinyan_blast_radius', () => {
  test('calls dep oracle correctly', async () => {
    const { server, oracle } = makeServer();
    const response = await server.handleRequest(makeToolCallRequest('vinyan_blast_radius', validHypothesis));

    expect(response.error).toBeUndefined();
    expect(oracle.calls).toHaveLength(1);
    expect(oracle.calls[0]!.name).toBe('dep');
  });
});

// ── vinyan_query_facts ──────────────────────────────────────────────

describe('vinyan_query_facts', () => {
  test('returns facts for known target', async () => {
    const { server } = makeServer();
    const response = await server.handleRequest(makeToolCallRequest('vinyan_query_facts', { target: 'src/app.ts' }));

    expect(response.error).toBeUndefined();
    const result = response.result as { content: Array<{ text: string }> };
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.count).toBe(1);
    expect(payload.facts[0].target).toBe('src/app.ts');
  });

  test('returns empty array for unknown target', async () => {
    const { server } = makeServer();
    const response = await server.handleRequest(
      makeToolCallRequest('vinyan_query_facts', { target: 'nonexistent.ts' }),
    );

    expect(response.error).toBeUndefined();
    const result = response.result as { content: Array<{ text: string }> };
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.count).toBe(0);
    expect(payload.facts).toHaveLength(0);
  });

  test('returns error when queryFacts not provided', async () => {
    const { server } = makeServer({ queryFacts: undefined });
    const response = await server.handleRequest(makeToolCallRequest('vinyan_query_facts', { target: 'src/app.ts' }));

    expect(response.error).toBeDefined();
    expect(response.error!.message).toContain('World Graph not available');
  });
});

// ── Error handling ──────────────────────────────────────────────────

describe('error handling', () => {
  test('unknown tool returns error', async () => {
    const { server } = makeServer();
    const response = await server.handleRequest(makeToolCallRequest('nonexistent_tool', {}));

    expect(response.error).toBeDefined();
    expect(response.error!.message).toContain('Unknown tool');
  });

  test('invalid JSON-RPC request returns error response', async () => {
    const { server } = makeServer();

    // Missing jsonrpc field
    const response = await server.handleRequest({
      id: 1,
      method: 'tools/list',
    });

    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32600); // Invalid Request
  });

  test('missing params on tools/call returns error', async () => {
    const { server } = makeServer();
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
    });

    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32602); // Invalid params
  });

  test('invalid hypothesis returns error', async () => {
    const { server } = makeServer();
    const response = await server.handleRequest(
      makeToolCallRequest('vinyan_ast_verify', { target: 'src/app.ts' }),
      // Missing 'pattern' and 'workspace'
    );

    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32602);
  });

  test('unknown method returns method not found', async () => {
    const { server } = makeServer();
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'unknown/method',
    });

    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32601); // Method not found
  });

  test('oracle exception is caught and returned as error', async () => {
    const server = new VinyanMCPServer({
      runOracle: async () => {
        throw new Error('Oracle crashed');
      },
    });

    const response = await server.handleRequest(makeToolCallRequest('vinyan_ast_verify', validHypothesis));

    expect(response.error).toBeDefined();
    expect(response.error!.message).toContain('Oracle crashed');
  });
});

// ── initialize ──────────────────────────────────────────────────────

describe('initialize', () => {
  test('returns server info and capabilities', async () => {
    const { server } = makeServer();
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
    });

    expect(response.error).toBeUndefined();
    const result = response.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe('2024-11-05');
    expect(result.serverInfo).toEqual({ name: 'vinyan', version: '0.5.5' });
  });
});

// ── ECP translation integration ─────────────────────────────────────

describe('ECP translation integration', () => {
  test('oracle verdict is properly translated to MCP result', async () => {
    const server = new VinyanMCPServer({
      runOracle: async (name, _h) =>
        buildVerdict({
          verified: false,
          type: 'unknown',
          confidence: 0,
          evidence: [],
          fileHashes: {},
          oracleName: name,
          reason: 'could not determine',
          durationMs: 3,
        }),
    });

    const response = await server.handleRequest(makeToolCallRequest('vinyan_ast_verify', validHypothesis));

    expect(response.error).toBeUndefined();
    const result = response.result as { content: Array<{ text: string }> };
    const payload = JSON.parse(result.content[0]!.text);
    // type='unknown' → verified: null
    expect(payload.verified).toBeNull();
    expect(payload.reason).toBe('insufficient evidence');
  });
});
