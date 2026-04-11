/**
 * MCP Client Pool — K2.5 lifecycle management + verified tool calls.
 *
 * Wraps MCPClientBridge instances with connection pooling, tool discovery,
 * and oracle-verified results. Each MCP server gets one bridge.
 *
 * A5 (Tiered Trust): All tool results pass through Oracle Gate verification.
 * A6 (Zero-Trust): Tool calls checked against AgentContract capabilities.
 */
import type { VinyanBus } from '../core/bus.ts';
import type { OracleVerdict } from '../core/types.ts';
import { MCPClientBridge, type MCPClientConfig } from './client-bridge.ts';
import type { MCPTool } from './types.ts';

export interface MCPServerConfig {
  name: string;
  command: string;
  args?: string[];
  trustLevel: MCPClientConfig['trustLevel'];
}

export interface MCPToolResult {
  verdict: OracleVerdict;
  serverName: string;
  toolName: string;
}

export interface VerifiedToolResult {
  verdict: OracleVerdict;
  verified: boolean;
  verificationDetails?: string;
}

export interface MCPClient {
  initialize(): Promise<void>;
  listTools(): Promise<MCPTool[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<OracleVerdict>;
  shutdown(): Promise<void>;
  readonly isConnected: boolean;
}

/** Gate interface for verifying MCP tool results. */
export interface MCPGate {
  verify(
    mutations: Array<{ file: string; content: string }>,
    workspace: string,
  ): Promise<{ passed: boolean; verdicts: Record<string, OracleVerdict> }>;
}

export class MCPClientPool {
  private clients = new Map<string, MCPClientBridge>();
  private configs: MCPServerConfig[];
  private bus?: VinyanBus;

  constructor(configs: MCPServerConfig[], bus?: VinyanBus) {
    this.configs = configs;
    this.bus = bus;
  }

  /** Initialize all configured MCP server connections. */
  async initialize(): Promise<void> {
    const connectPromises = this.configs.map(async (config) => {
      const bridge = new MCPClientBridge({
        name: config.name,
        command: config.command,
        args: config.args,
        trustLevel: config.trustLevel,
      });

      try {
        await bridge.connect();
        await bridge.discoverTools();
        this.clients.set(config.name, bridge);
      } catch (err) {
        // Connection failure is non-fatal — server may be unavailable
        console.warn(`[vinyan] MCP client '${config.name}' connection failed:`, err instanceof Error ? err.message : err);
      }
    });

    await Promise.allSettled(connectPromises);
  }

  /** Get a client bridge by server name. */
  getClient(serverName: string): MCPClientBridge | undefined {
    return this.clients.get(serverName);
  }

  /** List all connected server names. */
  listServers(): string[] {
    return Array.from(this.clients.keys());
  }

  /** List all tools across all connected servers. */
  async listAllTools(): Promise<Array<{ serverName: string; tool: MCPTool }>> {
    const results: Array<{ serverName: string; tool: MCPTool }> = [];
    for (const [serverName, client] of this.clients) {
      const tools = await client.discoverTools();
      for (const tool of tools) {
        results.push({ serverName, tool });
      }
    }
    return results;
  }

  /**
   * Call a tool and verify the result through Oracle Gate.
   *
   * G12: MCP tool call → oracle verification → verified result.
   */
  async callToolVerified(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    gate: MCPGate,
    workspace: string,
  ): Promise<VerifiedToolResult> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP server '${serverName}' not connected`);
    }

    // Call the tool
    const verdict = await client.callTool(toolName, args);

    // Verify through Oracle Gate — package the result as a "mutation" for verification
    const resultText = verdict.evidence
      .map((e) => e.snippet)
      .join('\n');

    try {
      const verification = await gate.verify(
        [{ file: `mcp://${serverName}/${toolName}`, content: resultText }],
        workspace,
      );

      return {
        verdict,
        verified: verification.passed,
        verificationDetails: verification.passed
          ? 'Oracle gate passed'
          : `Oracle gate failed: ${Object.entries(verification.verdicts)
              .filter(([, v]) => !v.verified)
              .map(([name]) => name)
              .join(', ')}`,
      };
    } catch {
      // Verification failure is non-fatal — return unverified result
      return {
        verdict,
        verified: false,
        verificationDetails: 'Oracle gate verification failed',
      };
    }
  }

  /** Shutdown all MCP server connections. */
  async shutdown(): Promise<void> {
    const disconnectPromises = Array.from(this.clients.entries()).map(
      async ([name, client]) => {
        try {
          await client.disconnect();
        } catch {
          console.warn(`[vinyan] MCP client '${name}' disconnect failed`);
        }
      },
    );
    await Promise.allSettled(disconnectPromises);
    this.clients.clear();
  }

  /** Number of connected servers. */
  get size(): number {
    return this.clients.size;
  }
}
