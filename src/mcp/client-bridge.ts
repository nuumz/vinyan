/**
 * MCP Client Bridge — PH5.5 WP-4.
 *
 * Connects to external MCP servers (subprocess over stdio) and wraps
 * their tools for use within Vinyan's ECP-based orchestrator.
 *
 * A5 (Tiered Trust): All external tool results get confidence capped
 * by the configured trust level. No external source can claim 'known'.
 */
import type { OracleVerdict } from '../core/types.ts';
import { type McpSourceZone, mcpToEcp } from './ecp-translation.ts';
import {
  type JsonRpcRequest,
  JsonRpcResponseSchema,
  type MCPTool,
  type MCPToolResult,
  MCPToolResultSchema,
  MCPToolSchema,
} from './types.ts';

export interface MCPClientConfig {
  /** Human-readable name for this MCP server connection. */
  name: string;
  /** Command to spawn the MCP server (e.g., "npx -y @mcp/server-filesystem"). */
  command: string;
  /** Additional arguments for the command. */
  args?: string[];
  /** Trust level for results from this server (A5). */
  trustLevel: McpSourceZone;
}

/** Subprocess handle with typed stdin/stdout for pipe mode. */
interface MCPSubprocess {
  stdin: { write(data: string): number; end(): void };
  stdout: ReadableStream<Uint8Array>;
  kill(): void;
  readonly exited: Promise<number>;
}

export class MCPClientBridge {
  private proc: MCPSubprocess | null = null;
  private nextId = 1;
  private tools: MCPTool[] = [];
  private responseBuffer = '';
  private pendingRequests = new Map<
    string | number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();

  constructor(private config: MCPClientConfig) {}

  /** Start the MCP server subprocess and initialize the connection. */
  async connect(): Promise<void> {
    const cmdParts = this.config.command.split(/\s+/);
    const allArgs = [...cmdParts, ...(this.config.args ?? [])];
    const [cmd, ...args] = allArgs;

    this.proc = Bun.spawn([cmd!, ...args], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    }) as unknown as MCPSubprocess;

    // Start reading responses in background
    this.startReading();

    // Send initialize
    await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'vinyan', version: '0.5.5' },
    });
  }

  /** Discover available tools from the remote MCP server. */
  async discoverTools(): Promise<MCPTool[]> {
    const result = await this.sendRequest('tools/list', {});
    if (result && typeof result === 'object' && 'tools' in result) {
      const toolsRaw = (result as Record<string, unknown>).tools;
      if (Array.isArray(toolsRaw)) {
        this.tools = toolsRaw
          .map((t) => MCPToolSchema.safeParse(t))
          .filter((r) => r.success)
          .map((r) => r.data!);
      }
    }
    return this.tools;
  }

  /**
   * Call a tool on the remote MCP server, wrapping the result in ECP.
   * A5: confidence capped by trust level.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<OracleVerdict> {
    const result = await this.sendRequest('tools/call', {
      name,
      arguments: args,
    });

    // Validate MCP result shape
    const parsed = MCPToolResultSchema.safeParse(result);
    if (!parsed.success) {
      // Treat unparseable result as an error
      const errorResult: MCPToolResult = {
        content: [
          {
            type: 'text' as const,
            text: `Failed to parse MCP tool result: ${parsed.error.message}`,
          },
        ],
        isError: true,
      };
      return mcpToEcp(errorResult, this.config.trustLevel);
    }

    return mcpToEcp(parsed.data, this.config.trustLevel);
  }

  /** Stop the MCP server subprocess. */
  async disconnect(): Promise<void> {
    if (this.proc) {
      // Resolve all pending requests with errors
      for (const [, pending] of this.pendingRequests) {
        pending.reject(new Error('MCP client disconnected'));
      }
      this.pendingRequests.clear();

      try {
        this.proc.stdin.end();
        this.proc.kill();
      } catch {
        // Subprocess may already be dead
      }
      this.proc = null;
    }
  }

  /** Check if the bridge is connected. */
  get isConnected(): boolean {
    return this.proc !== null;
  }

  // ── Private ─────────────────────────────────────────────────────

  private async sendRequest(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (!this.proc) {
      throw new Error(`MCP client '${this.config.name}' not connected`);
    }

    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });
      try {
        this.proc?.stdin.write(`${JSON.stringify(request)}\n`);
      } catch (err) {
        this.pendingRequests.delete(id);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  private async startReading(): Promise<void> {
    if (!this.proc) return;

    const reader = this.proc.stdout.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        this.responseBuffer += decoder.decode(value, { stream: true });
        const lines = this.responseBuffer.split('\n');
        this.responseBuffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            const parsed = JSON.parse(trimmed);
            const response = JsonRpcResponseSchema.safeParse(parsed);
            if (response.success) {
              const pending = this.pendingRequests.get(response.data.id);
              if (pending) {
                this.pendingRequests.delete(response.data.id);
                if (response.data.error) {
                  pending.reject(new Error(`MCP error ${response.data.error.code}: ${response.data.error.message}`));
                } else {
                  pending.resolve(response.data.result);
                }
              }
            }
          } catch {
            // Ignore unparseable lines from subprocess
          }
        }
      }
    } catch {
      // Stream ended or errored — reject remaining requests
      for (const [, pending] of this.pendingRequests) {
        pending.reject(new Error(`MCP server '${this.config.name}' stream ended`));
      }
      this.pendingRequests.clear();
    } finally {
      reader.releaseLock();
    }
  }
}
