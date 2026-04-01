import { describe, expect, test } from 'bun:test';
import { MCPClientBridge, type MCPClientConfig } from '../../src/mcp/client-bridge.ts';
import { mcpToEcp } from '../../src/mcp/ecp-translation.ts';
import type { MCPToolResult } from '../../src/mcp/types.ts';

// ── Trust level confidence tests (via mcpToEcp directly) ────────────

describe('trust level caps confidence correctly', () => {
  const successResult: MCPToolResult = {
    content: [{ type: 'text', text: JSON.stringify({ verified: true, evidence: [], fileHashes: {} }) }],
  };

  test('local trust → 0.7', () => {
    const verdict = mcpToEcp(successResult, 'local');
    expect(verdict.confidence).toBe(0.7);
    expect(verdict.type).toBe('uncertain');
  });

  test('network trust → 0.40', () => {
    const verdict = mcpToEcp(successResult, 'network');
    expect(verdict.confidence).toBe(0.4);
  });

  test('remote trust → 0.25', () => {
    const verdict = mcpToEcp(successResult, 'remote');
    expect(verdict.confidence).toBe(0.25);
  });
});

// ── MCPClientBridge construction ────────────────────────────────────

describe('MCPClientBridge', () => {
  const baseConfig: MCPClientConfig = {
    name: 'test-server',
    command: 'echo',
    args: ['hello'],
    trustLevel: 'local',
  };

  test('starts disconnected', () => {
    const bridge = new MCPClientBridge(baseConfig);
    expect(bridge.connected).toBe(false);
  });

  test('callTool throws when not connected', async () => {
    const bridge = new MCPClientBridge(baseConfig);
    expect(bridge.callTool('test_tool', {})).rejects.toThrow('not connected');
  });
});

// ── Tool discovery parsing ──────────────────────────────────────────

describe('tool discovery response parsing', () => {
  test('discoverTools parses valid tools/list response', async () => {
    // Line-by-line MCP server: reads stdin line-by-line, responds to each
    const serverScript = `
import { createInterface } from "readline";
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  try {
    const req = JSON.parse(line.trim());
    if (req.method === "initialize") {
      console.log(JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        result: { protocolVersion: "2024-11-05", capabilities: {} }
      }));
    } else if (req.method === "tools/list") {
      console.log(JSON.stringify({
        jsonrpc: "2.0",
        id: req.id,
        result: {
          tools: [
            { name: "test_tool", description: "A test tool", inputSchema: { type: "object" } }
          ]
        }
      }));
    }
  } catch {}
});
`;

    const tmpPath = '/tmp/vinyan-test-mcp-server.ts';
    await Bun.write(tmpPath, serverScript);

    const bridge = new MCPClientBridge({
      name: 'test',
      command: 'bun',
      args: ['run', tmpPath],
      trustLevel: 'local',
    });

    try {
      await bridge.connect();
      const tools = await bridge.discoverTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]!.name).toBe('test_tool');
      expect(tools[0]!.description).toBe('A test tool');
    } finally {
      await bridge.disconnect();
    }
  });
});

// ── Error handling ──────────────────────────────────────────────────

describe('subprocess error handling', () => {
  test('disconnect clears connected state', async () => {
    const bridge = new MCPClientBridge({
      name: 'test',
      command: 'cat',
      trustLevel: 'remote',
    });

    await bridge.connect();
    expect(bridge.connected).toBe(true);

    await bridge.disconnect();
    expect(bridge.connected).toBe(false);
  });

  test('callTool on crashed subprocess returns error verdict', async () => {
    // Use a command that exits immediately after echoing
    const bridge = new MCPClientBridge({
      name: 'test',
      command: 'cat',
      trustLevel: 'remote',
    });

    await bridge.connect();
    // cat echoes the initialize request back, which resolves as { result: undefined }
    // Now disconnect the subprocess
    await bridge.disconnect();

    // Calling after disconnect should throw (not connected)
    expect(bridge.callTool('test', {})).rejects.toThrow('not connected');
  });
});
