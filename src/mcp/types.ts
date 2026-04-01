/**
 * MCP (Model Context Protocol) type definitions — PH5.5 WP-4.
 * Zod schemas for JSON-RPC 2.0 and MCP-specific messages.
 * No external MCP SDK — protocol implemented manually.
 */
import { z } from 'zod/v4';

// ── JSON-RPC 2.0 base ───────────────────────────────────────────────

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});
export type JsonRpcRequest = z.infer<typeof JsonRpcRequestSchema>;

export const JsonRpcErrorSchema = z.object({
  code: z.number(),
  message: z.string(),
  data: z.unknown().optional(),
});
export type JsonRpcError = z.infer<typeof JsonRpcErrorSchema>;

export const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]),
  result: z.unknown().optional(),
  error: JsonRpcErrorSchema.optional(),
});
export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;

// ── MCP-specific schemas ────────────────────────────────────────────

export const MCPToolSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
});
export type MCPTool = z.infer<typeof MCPToolSchema>;

export const MCPToolCallSchema = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()),
});
export type MCPToolCall = z.infer<typeof MCPToolCallSchema>;

export const MCPToolResultSchema = z.object({
  content: z.array(
    z.object({
      type: z.literal('text'),
      text: z.string(),
    }),
  ),
  isError: z.boolean().optional(),
});
export type MCPToolResult = z.infer<typeof MCPToolResultSchema>;

// ── JSON-RPC error codes ────────────────────────────────────────────

export const JSON_RPC_ERRORS = {
  PARSE_ERROR: { code: -32700, message: 'Parse error' },
  INVALID_REQUEST: { code: -32600, message: 'Invalid Request' },
  METHOD_NOT_FOUND: { code: -32601, message: 'Method not found' },
  INVALID_PARAMS: { code: -32602, message: 'Invalid params' },
  INTERNAL_ERROR: { code: -32603, message: 'Internal error' },
} as const;
