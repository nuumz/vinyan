/**
 * ThinkingPolicy — Type system for Extensible Thinking.
 *
 * Decouples thinking depth (ambiguity) from verification depth (risk)
 * via a 2D routing grid governed by a deterministic ThinkingPolicy Compiler.
 *
 * Source of truth: docs/design/extensible-thinking-system-design.md §4.1
 * Axiom compliance: A1 (thinking is generation), A3 (deterministic governance), A6 (one-way policy)
 */
import { z } from 'zod/v4';
import type { ThinkingConfig } from '../types.ts';

// ── Profile System (4 profiles — AB/CD deferred to Phase 2.3) ───────────

export type ThinkingProfileId = 'A' | 'B' | 'C' | 'D';

// ── Task Uncertainty Signal ─────────────────────────────────────────────
// What we compute is task uncertainty (novelty + complexity), not linguistic ambiguity.
// Real ambiguity signals (NLP parse confidence, constraint conflicts) are Phase 3+ scope.

export interface TaskUncertaintySignal {
  /** Aggregate uncertainty score: 0.0–1.0 */
  score: number;
  /** Component breakdown for audit trail */
  components: {
    /** Deterministic: task structural complexity (A5: highest weight) */
    planComplexity: number;
    /** Heuristic: novelty decay curve — normalized 0-1 (A5: lower weight) */
    priorTraceCount: number;
  };
  /** How the signal was computed */
  basis: 'cold-start' | 'novelty-based' | 'calibrated';
}

// ── Core ThinkingPolicy Type ────────────────────────────────────────────

export interface ThinkingPolicy {
  /** How this policy was determined (metadata, NOT effectiveness claim — per EA-6) */
  policyBasis: 'default' | 'calibrated' | 'override';

  /** LLM thinking mode */
  thinking: ThinkingConfig;

  /** Which 2D profile does this policy instantiate */
  profileId: ThinkingProfileId;

  /** Uncertainty score that influenced this policy */
  uncertaintyScore?: number;

  /** Risk score passed to compiler (audit trail) */
  riskScore?: number;

  /** SelfModel confidence for this task type */
  selfModelConfidence?: number;

  /** Content-addressed observation key for A7 learning (A4: SHA-256 of target file hashes) */
  observationKey?: string;

  /** Non-monotonic ceiling (P9) — never 0, minimum 10% of base budget */
  thinkingCeiling?: number;

  /** Per-task-type calibration slot */
  taskTypeCalibration?: {
    taskTypeSignature: string;
    minObservationCount: number;
    basis: 'insufficient' | 'emerging' | 'calibrated';
  };
}

// ── ThinkingPolicy Compiler Interface ───────────────────────────────────

export interface ThinkingPolicyCompiler {
  compile(input: ThinkingPolicyInput): Promise<ThinkingPolicy>;
}

export interface ThinkingPolicyInput {
  taskInput: {
    id: string;
    targetFiles?: string[];
    constraints?: string[];
    acceptanceCriteria?: string[];
    taskType: string;
    goal: string;
  };
  riskScore: number;
  uncertaintySignal: TaskUncertaintySignal;
  routingLevel: 0 | 1 | 2 | 3;
  taskTypeSignature: string;
  selfModelConfidence?: number;
  thresholds?: { riskBoundary: number; uncertaintyBoundary: number };
}

// ── Counterfactual Context (Phase 2.2) ──────────────────────────────────

export interface CounterfactualContext {
  failureReason: string;
  previousBudget: number;
  oracleVerdicts: Array<{
    oracleId: string;
    passed: boolean;
    confidence: number;
    failureDetail?: string;
  }>;
  constraintViolations: string[];
  retryNumber: number;
  maxRetries: number;
}

// ── Zod Schemas ─────────────────────────────────────────────────────────

export const ThinkingProfileIdSchema = z.enum(['A', 'B', 'C', 'D']);

export const TaskUncertaintySignalSchema = z.object({
  score: z.number().min(0).max(1),
  components: z.object({
    planComplexity: z.number().min(0).max(1),
    priorTraceCount: z.number().min(0).max(1),
  }),
  basis: z.enum(['cold-start', 'novelty-based', 'calibrated']),
});

export const ThinkingPolicySchema = z.object({
  policyBasis: z.enum(['default', 'calibrated', 'override']),
  thinking: z.union([
    z.object({ type: z.literal('adaptive'), effort: z.enum(['low', 'medium', 'high', 'max']), display: z.enum(['omitted', 'summarized']).optional() }),
    z.object({ type: z.literal('enabled'), budgetTokens: z.number().positive(), display: z.enum(['omitted', 'summarized']).optional() }),
    z.object({ type: z.literal('disabled') }),
  ]),
  profileId: ThinkingProfileIdSchema,
  uncertaintyScore: z.number().min(0).max(1).optional(),
  riskScore: z.number().min(0).max(1).optional(),
  selfModelConfidence: z.number().min(0).max(1).optional(),
  observationKey: z.string().optional(),
  thinkingCeiling: z.number().min(0).optional(),
  taskTypeCalibration: z.object({
    taskTypeSignature: z.string(),
    minObservationCount: z.number().min(0),
    basis: z.enum(['insufficient', 'emerging', 'calibrated']),
  }).optional(),
});
