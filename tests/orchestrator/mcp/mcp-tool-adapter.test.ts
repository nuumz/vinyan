/**
 * Phase 7e: Tests for the MCP → Vinyan tool adapter. Covers name
 * namespacing, schema conversion, verdict → ToolResult translation,
 * error handling, and `buildMcpToolMap` behavior against a mock pool.
 */

import { describe, expect, test } from 'bun:test';
import type { OracleVerdict } from '../../../src/core/types.ts';
import type { MCPGate, VerifiedToolResult } from '../../../src/mcp/client.ts';
import type { MCPTool } from '../../../src/mcp/types.ts';
import {
  buildMcpToolMap,
  createMcpTool,
  type McpPool,
  mcpToolName,
  parseMcpToolName,
  verifiedResultToToolResult,
} from '../../../src/orchestrator/mcp/mcp-tool-adapter.ts';

// ── Shared fixtures ────────────────────────────────────────────────

const NOOP_GATE: MCPGate = {
  verify: async () => ({ passed: true, verdicts: {} }),
};

function makeVerdict(partial: Partial<OracleVerdict> = {}): OracleVerdict {
  return {
    verified: true,
    type: 'uncertain',
    confidence: 0.5,
    evidence: [],
    fileHashes: {},
    durationMs: 0,
    ...partial,
  };
}

function makeMcpTool(overrides: Partial<MCPTool> = {}): MCPTool {
  return {
    name: 'echo',
    description: 'Echo a message',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Text to echo' },
      },
      required: ['message'],
    },
    ...overrides,
  };
}

function mockPool(
  entries: Array<{ serverName: string; tool: MCPTool }>,
  callImpl?: (
    server: string,
    tool: string,
    args: Record<string, unknown>,
  ) => Promise<VerifiedToolResult> | VerifiedToolResult,
): McpPool {
  return {
    listAllTools: async () => entries,
    callToolVerified: async (server, tool, args, _gate, _workspace) => {
      if (callImpl) return callImpl(server, tool, args);
      return {
        verdict: makeVerdict({ evidence: [{ file: '', line: 0, snippet: 'ok' }] }),
        verified: true,
      };
    },
  };
}

// ── Namespace helpers ──────────────────────────────────────────────

describe('mcpToolName / parseMcpToolName', () => {
  test('namespaces server + tool with double-underscore', () => {
    expect(mcpToolName('github', 'create_issue')).toBe('mcp__github__create_issue');
  });

  test('parses namespaced name back into parts', () => {
    const parts = parseMcpToolName('mcp__github__create_issue');
    expect(parts).toEqual({ serverName: 'github', toolName: 'create_issue' });
  });

  test('parses tool names containing separators (split only on first)', () => {
    const parts = parseMcpToolName('mcp__fs__read__dir');
    expect(parts).toEqual({ serverName: 'fs', toolName: 'read__dir' });
  });

  test('returns null for non-MCP names', () => {
    expect(parseMcpToolName('file_read')).toBeNull();
    expect(parseMcpToolName('mcp_')).toBeNull();
    expect(parseMcpToolName('mcp__')).toBeNull();
    expect(parseMcpToolName('mcp__server_only')).toBeNull();
  });

  test('round-trips namespacing and parsing', () => {
    const name = mcpToolName('slack', 'post_message');
    const parts = parseMcpToolName(name);
    expect(parts?.serverName).toBe('slack');
    expect(parts?.toolName).toBe('post_message');
  });
});

// ── verifiedResultToToolResult ─────────────────────────────────────

describe('verifiedResultToToolResult', () => {
  test('verified=true → status="success" with concatenated snippets', () => {
    const verified: VerifiedToolResult = {
      verdict: makeVerdict({
        verified: true,
        evidence: [
          { file: '', line: 0, snippet: 'line-one' },
          { file: '', line: 0, snippet: 'line-two' },
        ],
        durationMs: 42,
      }),
      verified: true,
    };
    const result = verifiedResultToToolResult('call-1', 'mcp__s__t', verified);
    expect(result.status).toBe('success');
    expect(result.output).toBe('line-one\nline-two');
    expect(result.durationMs).toBe(42);
    expect(result.callId).toBe('call-1');
    expect(result.tool).toBe('mcp__s__t');
  });

  test('verified=false → status="error" with reason', () => {
    const verified: VerifiedToolResult = {
      verdict: makeVerdict({
        verified: false,
        reason: 'remote server returned isError',
      }),
      verified: false,
    };
    const result = verifiedResultToToolResult('call-2', 'mcp__s__t', verified);
    expect(result.status).toBe('error');
    expect(result.error).toBe('remote server returned isError');
  });

  test('empty evidence → placeholder output', () => {
    const verified: VerifiedToolResult = {
      verdict: makeVerdict({ evidence: [] }),
      verified: true,
    };
    const result = verifiedResultToToolResult('call-3', 'mcp__s__t', verified);
    expect(result.output).toBe('(empty MCP response)');
  });

  test('filters empty snippets before joining', () => {
    const verified: VerifiedToolResult = {
      verdict: makeVerdict({
        evidence: [
          { file: '', line: 0, snippet: '' },
          { file: '', line: 0, snippet: 'real' },
          { file: '', line: 0, snippet: '' },
        ],
      }),
      verified: true,
    };
    const result = verifiedResultToToolResult('c', 't', verified);
    expect(result.output).toBe('real');
  });
});

// ── createMcpTool ──────────────────────────────────────────────────

describe('createMcpTool', () => {
  test('produces namespaced Tool with correct descriptor', () => {
    const pool = mockPool([]);
    const tool = createMcpTool(pool, 'github', makeMcpTool(), NOOP_GATE, '/tmp/ws');
    expect(tool.name).toBe('mcp__github__echo');
    expect(tool.minIsolationLevel).toBe(2);
    expect(tool.category).toBe('delegation');
    expect(tool.sideEffect).toBe(true);

    const desc = tool.descriptor();
    expect(desc.name).toBe('mcp__github__echo');
    expect(desc.minRoutingLevel).toBe(2);
    expect(desc.toolKind).toBe('executable');
    expect(desc.inputSchema.type).toBe('object');
    expect(desc.inputSchema.properties.message).toEqual({
      type: 'string',
      description: 'Text to echo',
    });
    expect(desc.inputSchema.required).toEqual(['message']);
  });

  test('empty description falls back to server-scoped placeholder', () => {
    const pool = mockPool([]);
    const tool = createMcpTool(pool, 'github', makeMcpTool({ description: '' }), NOOP_GATE, '/tmp/ws');
    expect(tool.description).toContain('github');
  });

  test('non-object input schema falls back to single input field', () => {
    const pool = mockPool([]);
    const tool = createMcpTool(pool, 'weird', makeMcpTool({ inputSchema: { type: 'string' } }), NOOP_GATE, '/tmp/ws');
    const desc = tool.descriptor();
    expect(desc.inputSchema.type).toBe('object');
    expect(desc.inputSchema.properties.input).toBeDefined();
    expect(desc.inputSchema.required).toEqual([]);
  });

  test('enum + items fields are preserved in descriptor', () => {
    const pool = mockPool([]);
    const tool = createMcpTool(
      pool,
      'gh',
      makeMcpTool({
        inputSchema: {
          type: 'object',
          properties: {
            mode: { type: 'string', description: 'Operating mode', enum: ['read', 'write'] },
            tags: { type: 'array', description: 'Tags', items: { type: 'string' } },
          },
          required: ['mode'],
        },
      }),
      NOOP_GATE,
      '/tmp/ws',
    );
    const desc = tool.descriptor();
    expect(desc.inputSchema.properties.mode?.enum).toEqual(['read', 'write']);
    expect(desc.inputSchema.properties.tags?.items).toEqual({ type: 'string' });
  });

  test('execute forwards args to pool.callToolVerified and strips callId', async () => {
    let receivedArgs: Record<string, unknown> | undefined;
    let receivedServer: string | undefined;
    let receivedTool: string | undefined;
    const pool = mockPool([], async (server, toolName, args) => {
      receivedServer = server;
      receivedTool = toolName;
      receivedArgs = args;
      return {
        verdict: makeVerdict({ evidence: [{ file: '', line: 0, snippet: 'ok' }] }),
        verified: true,
      };
    });
    const tool = createMcpTool(pool, 'github', makeMcpTool(), NOOP_GATE, '/tmp/ws');
    const result = await tool.execute(
      { message: 'hi', callId: 'c-1' },
      {
        routingLevel: 2,
        allowedPaths: [],
        workspace: '/tmp/ws',
      },
    );
    expect(receivedServer).toBe('github');
    expect(receivedTool).toBe('echo');
    expect(receivedArgs).toEqual({ message: 'hi' });
    expect(result.status).toBe('success');
    expect(result.output).toBe('ok');
    expect(result.callId).toBe('c-1');
  });

  test('execute surfaces thrown errors as error ToolResult', async () => {
    const pool = mockPool([], async () => {
      throw new Error('connection lost');
    });
    const tool = createMcpTool(pool, 'github', makeMcpTool(), NOOP_GATE, '/tmp/ws');
    const result = await tool.execute(
      { message: 'hi', callId: 'c-2' },
      { routingLevel: 2, allowedPaths: [], workspace: '/tmp/ws' },
    );
    expect(result.status).toBe('error');
    expect(result.error).toBe('connection lost');
  });
});

// ── buildMcpToolMap ────────────────────────────────────────────────

describe('buildMcpToolMap', () => {
  test('builds one Tool per discovered MCP tool', async () => {
    const pool = mockPool([
      { serverName: 'github', tool: makeMcpTool({ name: 'create_issue' }) },
      { serverName: 'github', tool: makeMcpTool({ name: 'list_repos' }) },
      { serverName: 'slack', tool: makeMcpTool({ name: 'post_message' }) },
    ]);
    const map = await buildMcpToolMap(pool, NOOP_GATE, '/tmp/ws');
    expect(map.size).toBe(3);
    expect(map.has('mcp__github__create_issue')).toBe(true);
    expect(map.has('mcp__github__list_repos')).toBe(true);
    expect(map.has('mcp__slack__post_message')).toBe(true);
  });

  test('returns empty map when pool listAllTools throws', async () => {
    const pool: McpPool = {
      listAllTools: async () => {
        throw new Error('pool broken');
      },
      callToolVerified: async () => ({ verdict: makeVerdict(), verified: true }),
    };
    const map = await buildMcpToolMap(pool, NOOP_GATE, '/tmp/ws');
    expect(map.size).toBe(0);
  });

  test('duplicate names across servers: first wins', async () => {
    const pool = mockPool([
      { serverName: 'a', tool: makeMcpTool({ name: 'ping', description: 'first' }) },
      { serverName: 'a', tool: makeMcpTool({ name: 'ping', description: 'second' }) },
    ]);
    const map = await buildMcpToolMap(pool, NOOP_GATE, '/tmp/ws');
    expect(map.size).toBe(1);
    expect(map.get('mcp__a__ping')?.description).toBe('first');
  });

  test('returns empty map for a pool with zero servers', async () => {
    const pool = mockPool([]);
    const map = await buildMcpToolMap(pool, NOOP_GATE, '/tmp/ws');
    expect(map.size).toBe(0);
  });
});
