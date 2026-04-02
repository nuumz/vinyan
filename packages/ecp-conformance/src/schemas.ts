/**
 * Conformance validation schemas — minimal Zod schemas for ECP verdict validation.
 *
 * These schemas are intentionally separate from the Oracle SDK schemas to allow
 * standalone conformance testing without importing the full SDK.
 */

import { z } from 'zod/v4';

// ── Level 0: Required fields only ────────────────────────────────────

export const EvidenceSchema = z.object({
  file: z.string(),
  line: z.number(),
  snippet: z.string(),
  contentHash: z.string().optional(),
});

export const Level0VerdictSchema = z.object({
  verified: z.boolean(),
  evidence: z.array(EvidenceSchema),
  fileHashes: z.record(z.string(), z.string()),
  duration_ms: z.number().optional(),
  durationMs: z.number().optional(),
}).refine(
  (v) => v.duration_ms !== undefined || v.durationMs !== undefined,
  { message: 'Level 0 requires duration_ms or durationMs field' },
);

// ── Level 1: Adds epistemic types, confidence, falsifiability ────────

const VALID_SCOPES = ['file', 'dependency', 'env', 'config', 'time'] as const;
const VALID_EVENTS = ['content-change', 'version-change', 'deletion', 'expiry'] as const;

export const FalsifiabilityConditionPattern = /^(file|dependency|env|config|time):.+:(content-change|version-change|deletion|expiry)$/;

export const Level1VerdictSchema = z.object({
  verified: z.boolean(),
  type: z.enum(['known', 'unknown', 'uncertain', 'contradictory']),
  confidence: z.number().min(0).max(1),
  evidence: z.array(EvidenceSchema.extend({
    contentHash: z.string(), // Required at Level 1 (A4 compliance)
  })),
  falsifiableBy: z.array(z.string()).optional(),
  fileHashes: z.record(z.string(), z.string()),
  durationMs: z.number(),
});

// ── Level 2: Adds temporal context, deliberation, version ────────────

export const TemporalContextSchema = z.object({
  validFrom: z.number(),
  validUntil: z.number(),
  decayModel: z.enum(['linear', 'step', 'none']),
});

export const DeliberationRequestSchema = z.object({
  reason: z.string(),
  suggestedBudget: z.number(),
});

export const Level2VerdictSchema = Level1VerdictSchema.extend({
  temporalContext: TemporalContextSchema.optional(),
  deliberationRequest: DeliberationRequestSchema.optional(),
});

// ── JSON-RPC envelope (Level 1+) ────────────────────────────────────

export const JsonRpcRequestSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]),
  method: z.string(),
  params: z.record(z.string(), z.unknown()),
});

export const JsonRpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.object({
    code: z.number(),
    message: z.string(),
  }).optional(),
});

// ── Version negotiation (Level 2+) ──────────────────────────────────

export const VersionHandshakeSchema = z.object({
  ecp_version: z.number(),
  supported_versions: z.array(z.number()),
  engine_name: z.string(),
  tier: z.enum(['deterministic', 'heuristic', 'probabilistic']),
  patterns: z.array(z.string()),
  languages: z.array(z.string()),
});

export const VersionResponseSchema = z.object({
  negotiated_version: z.number(),
  instance_id: z.string(),
  features: z.array(z.string()),
});

// ── Level 3: Cross-instance coordination ────────────────────────────

export const Level3VerdictSchema = Level2VerdictSchema.extend({
  sourceInstanceId: z.string().min(1),
  origin: z.enum(['local', 'a2a']).optional(),
  signature: z.string().optional(),
  signerInstanceId: z.string().optional(),
});

export const KnowledgeOfferSchema = z.object({
  cycleId: z.string(),
  instanceId: z.string().min(1),
  patterns: z.array(z.object({
    id: z.string(),
    type: z.string(),
    confidence: z.number().min(0).max(1),
    portability: z.enum(['universal', 'framework-specific', 'project-specific']),
  })),
});

export const KnowledgeAcceptanceSchema = z.object({
  acceptedPatternIds: z.array(z.string()),
  rejectedPatternIds: z.array(z.string()),
});

export const KnowledgeTransferSchema = z.object({
  cycleId: z.string(),
  instanceId: z.string().min(1),
  patterns: z.array(z.object({
    id: z.string(),
    type: z.string(),
    confidence: z.number().min(0).max(1),
    fingerprint: z.string(),
    portability: z.enum(['universal', 'framework-specific', 'project-specific']),
  })),
});
