/**
 * Vinyan MCP Server — PH5.5 WP-4.
 *
 * Exposes 4 Vinyan tools via MCP protocol over stdio JSON-RPC:
 *   1. vinyan_ast_verify  — Run AST oracle on a hypothesis
 *   2. vinyan_type_check  — Run type oracle on a hypothesis
 *   3. vinyan_blast_radius — Run dependency oracle
 *   4. vinyan_query_facts — Query World Graph facts
 *
 * A3 (Deterministic Governance): Tool routing is rule-based, no LLM in path.
 * A6 (Zero-Trust Execution): All inputs validated via Zod before execution.
 */
import type { Fact, HypothesisTuple, OracleVerdict } from '../core/types.ts';
import { HypothesisTupleSchema } from '../oracle/protocol.ts';
import { ecpToMcp } from './ecp-translation.ts';
import {
  JSON_RPC_ERRORS,
  JsonRpcRequestSchema,
  type JsonRpcResponse,
  type MCPTool,
  MCPToolCallSchema,
  type MCPToolResult,
} from './types.ts';

/** Hypothesis input schema for MCP tool descriptions. */
const HYPOTHESIS_INPUT_SCHEMA = {
  type: 'object',
  properties: {
    target: { type: 'string', description: 'File path or symbol identifier' },
    pattern: { type: 'string', description: 'What to verify (e.g. symbol-exists, function-signature)' },
    workspace: { type: 'string', description: 'Absolute path to workspace root' },
    context: { type: 'object', description: 'Additional context for the oracle' },
  },
  required: ['target', 'pattern', 'workspace'],
} as const;

/** Tool definitions exposed by this MCP server. */
const TOOL_DEFINITIONS: MCPTool[] = [
  {
    name: 'vinyan_ast_verify',
    description:
      'Run Vinyan AST oracle to verify structural code properties (symbol existence, function signatures, imports)',
    inputSchema: HYPOTHESIS_INPUT_SCHEMA,
  },
  {
    name: 'vinyan_type_check',
    description: 'Run Vinyan type oracle (tsc --noEmit) to verify type correctness',
    inputSchema: HYPOTHESIS_INPUT_SCHEMA,
  },
  {
    name: 'vinyan_blast_radius',
    description: 'Run Vinyan dependency oracle to analyze import graph and blast radius of changes',
    inputSchema: HYPOTHESIS_INPUT_SCHEMA,
  },
  {
    name: 'vinyan_query_facts',
    description: 'Query Vinyan World Graph for verified facts about a target file or symbol',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'File path or symbol to query facts for' },
      },
      required: ['target'],
    },
  },
];

/** Maps MCP tool names to oracle names. */
const TOOL_TO_ORACLE: Record<string, string> = {
  vinyan_ast_verify: 'ast',
  vinyan_type_check: 'type',
  vinyan_blast_radius: 'dep',
};

export interface VinyanMCPServerDeps {
  runOracle: (name: string, hypothesis: HypothesisTuple) => Promise<OracleVerdict>;
  queryFacts?: (target: string) => Fact[];
}

export class VinyanMCPServer {
  constructor(private deps: VinyanMCPServerDeps) {}

  /** List available tools (tools/list method). */
  listTools(): MCPTool[] {
    return TOOL_DEFINITIONS;
  }

  /** Process a single JSON-RPC request and return a response. */
  async handleRequest(raw: unknown): Promise<JsonRpcResponse> {
    // Validate JSON-RPC envelope
    const parseResult = JsonRpcRequestSchema.safeParse(raw);
    if (!parseResult.success) {
      return {
        jsonrpc: '2.0',
        id:
          typeof raw === 'object' && raw !== null && 'id' in raw
            ? ((raw as Record<string, unknown>).id as string | number)
            : 0,
        error: JSON_RPC_ERRORS.INVALID_REQUEST,
      };
    }

    const request = parseResult.data;

    switch (request.method) {
      case 'initialize':
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'vinyan', version: '0.5.5' },
          },
        };

      case 'tools/list':
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: { tools: this.listTools() },
        };

      case 'tools/call':
        return this.handleToolCall(request.id, request.params);

      default:
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: JSON_RPC_ERRORS.METHOD_NOT_FOUND,
        };
    }
  }

  /** Start stdio transport — read lines from stdin, write responses to stdout. */
  async startStdio(): Promise<void> {
    const reader = Bun.stdin.stream().getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        // Keep incomplete last line in buffer
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let parsed: unknown;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            const errorResponse: JsonRpcResponse = {
              jsonrpc: '2.0',
              id: 0,
              error: JSON_RPC_ERRORS.PARSE_ERROR,
            };
            process.stdout.write(`${JSON.stringify(errorResponse)}\n`);
            continue;
          }

          const response = await this.handleRequest(parsed);
          process.stdout.write(`${JSON.stringify(response)}\n`);
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // ── Private ─────────────────────────────────────────────────────

  private async handleToolCall(
    id: string | number,
    params: Record<string, unknown> | undefined,
  ): Promise<JsonRpcResponse> {
    if (!params) {
      return {
        jsonrpc: '2.0',
        id,
        error: JSON_RPC_ERRORS.INVALID_PARAMS,
      };
    }

    // Validate tool call shape
    const toolParse = MCPToolCallSchema.safeParse(params);
    if (!toolParse.success) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          ...JSON_RPC_ERRORS.INVALID_PARAMS,
          data: toolParse.error.message,
        },
      };
    }

    const { name, arguments: args } = toolParse.data;

    // Route: vinyan_query_facts is special (not an oracle)
    if (name === 'vinyan_query_facts') {
      return this.handleQueryFacts(id, args);
    }

    // Route: oracle-based tools
    const oracleName = TOOL_TO_ORACLE[name];
    if (!oracleName) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: JSON_RPC_ERRORS.METHOD_NOT_FOUND.code,
          message: `Unknown tool: ${name}`,
        },
      };
    }

    return this.handleOracleCall(id, oracleName, args);
  }

  private async handleOracleCall(
    id: string | number,
    oracleName: string,
    args: Record<string, unknown>,
  ): Promise<JsonRpcResponse> {
    // Validate hypothesis
    const hypothesisParse = HypothesisTupleSchema.safeParse(args);
    if (!hypothesisParse.success) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          ...JSON_RPC_ERRORS.INVALID_PARAMS,
          data: hypothesisParse.error.message,
        },
      };
    }

    try {
      const verdict = await this.deps.runOracle(oracleName, hypothesisParse.data);
      const mcpResult = ecpToMcp(verdict);
      return {
        jsonrpc: '2.0',
        id,
        result: mcpResult,
      };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: JSON_RPC_ERRORS.INTERNAL_ERROR.code,
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  private handleQueryFacts(id: string | number, args: Record<string, unknown>): JsonRpcResponse {
    if (!this.deps.queryFacts) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: JSON_RPC_ERRORS.INTERNAL_ERROR.code,
          message: 'World Graph not available',
        },
      };
    }

    const target = args.target;
    if (typeof target !== 'string') {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          ...JSON_RPC_ERRORS.INVALID_PARAMS,
          data: 'target must be a string',
        },
      };
    }

    const facts = this.deps.queryFacts(target);
    const result: MCPToolResult = {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({ facts, count: facts.length }),
        },
      ],
    };

    return {
      jsonrpc: '2.0',
      id,
      result,
    };
  }
}
