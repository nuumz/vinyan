/**
 * A2A Protocol Types — Google's Agent-to-Agent protocol (PH5.6).
 *
 * Zod schemas for JSON-RPC protocol boundaries per project convention.
 * All external A2A data is validated through these schemas.
 */
import { z } from 'zod';

// ── A2A Task States ─────────────────────────────────────────────────

export const A2ATaskStateSchema = z.enum(['submitted', 'working', 'input-required', 'completed', 'canceled', 'failed']);

export type A2ATaskState = z.infer<typeof A2ATaskStateSchema>;

// ── A2A Message Parts ───────────────────────────────────────────────

export const A2APartSchema = z.object({
  type: z.enum(['text', 'data', 'file']),
  text: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
  mimeType: z.string().optional(),
});

export const A2AMessageSchema = z.object({
  role: z.enum(['user', 'agent']),
  parts: z.array(A2APartSchema),
});

export type A2AMessage = z.infer<typeof A2AMessageSchema>;

// ── A2A Task ────────────────────────────────────────────────────────

export const A2AArtifactPartSchema = z.object({
  type: z.enum(['text', 'data']),
  text: z.string().optional(),
  data: z.record(z.string(), z.unknown()).optional(),
});

export const A2AArtifactSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  parts: z.array(A2AArtifactPartSchema),
});

export const A2ATaskSchema = z.object({
  id: z.string(),
  status: z.object({
    state: A2ATaskStateSchema,
    message: A2AMessageSchema.optional(),
  }),
  artifacts: z.array(A2AArtifactSchema).optional(),
});

export type A2ATask = z.infer<typeof A2ATaskSchema>;

// ── A2A Agent Card ──────────────────────────────────────────────────

export const A2ASkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()).optional(),
});

// ── Vinyan ECP Extension for Agent Card ────────────────────────────────

export const VinyanOracleCapabilitySchema = z.object({
  name: z.string(),
  tier: z.enum(['deterministic', 'heuristic', 'probabilistic', 'speculative']),
  languages: z.array(z.string()),
  accuracy: z.number().optional(),
  latency_ms: z.number().optional(),
});

export const VinyanECPExtensionSchema = z.object({
  protocol: z.literal('vinyan-ecp'),
  ecp_version: z.literal(1),
  instance_id: z.string(),
  public_key: z.string(),
  capability_version: z.number(),
  oracle_capabilities: z.array(VinyanOracleCapabilitySchema),
  features: z.array(z.string()),
  calibration: z
    .object({
      brier_score: z.number().optional(),
      sample_size: z.number().optional(),
      bias_direction: z.enum(['overconfident', 'underconfident', 'calibrated']).optional(),
    })
    .optional(),
});

export type VinyanECPExtension = z.infer<typeof VinyanECPExtensionSchema>;

export const A2AAgentCardSchema = z.object({
  name: z.string(),
  description: z.string(),
  url: z.string(),
  version: z.string(),
  capabilities: z.object({
    streaming: z.boolean().default(false),
    pushNotifications: z.boolean().default(false),
  }),
  skills: z.array(A2ASkillSchema),
  'x-vinyan-ecp': VinyanECPExtensionSchema.optional(),
});

export type A2AAgentCard = z.infer<typeof A2AAgentCardSchema>;

// ── A2A JSON-RPC Envelope ───────────────────────────────────────────

export const A2AJsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]),
  method: z.enum(['tasks/send', 'tasks/get', 'tasks/cancel']),
  params: z.record(z.string(), z.unknown()),
});

export type A2AJsonRpcRequest = z.infer<typeof A2AJsonRpcRequestSchema>;

/** Standard JSON-RPC 2.0 response envelope */
export interface A2AJsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}
