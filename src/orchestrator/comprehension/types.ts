/**
 * Conversation Comprehension types — ECP-compliant message envelope and engine contract.
 *
 * Design rationale (from docs/analysis + debate):
 *  - Axiom A1 (Epistemic Separation): engine proposes → oracle verifies → orchestrator commits.
 *    ComprehensionEngine generates; a separate ComprehensionOracle (see
 *    src/oracle/comprehension/) verifies.
 *  - Axiom A2 (First-Class Uncertainty): `type: 'comprehension' | 'unknown'`. The engine
 *    MUST return `unknown` when it cannot resolve confidently — never hallucinate.
 *  - Axiom A3 (Deterministic Governance): orchestrator decisions read structured fields
 *    (state.isClarificationAnswer, tier) — not free-form text.
 *  - Axiom A4 (Content-Addressed Truth): `inputHash` binds each comprehension to its
 *    source material (session history snapshot + user message); consumers can cache on it.
 *  - Axiom A5 (Tiered Trust): `tier` + `evidence_chain` are first-class. Deterministic
 *    evidence outranks probabilistic (LLM-advisory) on merge.
 *  - Axiom A6 (Zero-Trust Execution): workers never see the raw message — only
 *    oracle-verified data projected into their prompt.
 *  - Axiom A7 (Prediction Error as Learning): TraceCollector records both the
 *    comprehension and the downstream outcome so SelfModel can calibrate accuracy.
 *
 * This module defines only types and Zod schemas. Implementations live in
 * `rule-comprehender.ts` (stage 1, deterministic) and later `llm-comprehender.ts`
 * (stage 2, probabilistic — P2).
 */

import { z } from 'zod';
import type { TaskInput, Turn } from '../types.ts';

// ── Trust tier + message envelope ──────────────────────────────────────

/** ECP trust tier (A5). Matches existing oracle/tier-clamp.ts vocabulary. */
export const ComprehensionTierSchema = z.enum(['deterministic', 'heuristic', 'probabilistic', 'unknown']);
export type ComprehensionTier = z.infer<typeof ComprehensionTierSchema>;

/** Single entry in the evidence chain (A5). `contentHash` binds to immutable source (A4). */
export const ComprehensionEvidenceSchema = z.object({
  source: z.string(), // e.g. 'rule:referent-resolver' | 'session:history' | 'llm:advisory'
  claim: z.string(),
  confidence: z.number().min(0).max(1),
  contentHash: z.string().optional(),
});
export type ComprehensionEvidence = z.infer<typeof ComprehensionEvidenceSchema>;

/**
 * Conversation state flags — structured signals the orchestrator (rule-based,
 * governance-safe) can read without inspecting free-form text.
 */
export const ComprehensionStateSchema = z.object({
  /** True when there is no prior user/assistant turn in the session. */
  isNewTopic: z.boolean(),
  /**
   * True when the previous assistant turn was [INPUT-REQUIRED] and this user
   * message is the answer. Downstream routing MUST preserve the workflow.
   */
  isClarificationAnswer: z.boolean(),
  /**
   * True when the user's message is a short follow-up to an existing task
   * (e.g. "ok", "continue", "ยกเลิก"). Includes isClarificationAnswer by
   * construction — a clarification answer is always a follow-up.
   */
  isFollowUp: z.boolean(),
  /**
   * True when the literal message contains ambiguous referents that could
   * not be resolved by rule. If true and LLM unavailable, the downstream
   * pipeline treats the goal as provisional (tier ≤ heuristic).
   */
  hasAmbiguousReferents: z.boolean(),
  /** Open clarification questions from the last assistant turn (carried over). */
  pendingQuestions: z.array(z.string()),
  /**
   * The root user task that the current conversation thread is resolving.
   * Walks back through [assistant-IR, user-reply] pairs to the original
   * user request. Null when there is no prior anchor (e.g. fresh session).
   */
  rootGoal: z.string().nullable(),
});
export type ComprehensionState = z.infer<typeof ComprehensionStateSchema>;

/**
 * Memory lanes that the comprehender flagged as relevant for this turn.
 * Each lane carries references (file paths, memory IDs), not contents — the
 * prompt assembler resolves them later with tier-aware injection.
 *
 * P1 wires the actual loader; P0 emits empty structure so downstream code
 * is forward-compatible.
 */
export const ComprehensionMemoryLanesSchema = z.object({
  /** Managed: /etc/vinyan or equivalent, highest trust. */
  managed: z.array(z.string()).optional(),
  /** User-level: ~/.claude/CLAUDE.md etc. */
  user: z.array(z.string()).optional(),
  /** Project-level: VINYAN.md and descendants. */
  project: z.array(z.string()).optional(),
  /** Local: machine-local overrides. */
  local: z.array(z.string()).optional(),
  /**
   * AutoMemory: LLM-written entries (~/.claude/projects/<slug>/memory/MEMORY.md).
   * Each reference is ALWAYS tagged probabilistic — do NOT promote without
   * oracle verification (Red Team #3 — second-order injection risk).
   */
  autoMem: z
    .array(
      z.object({
        ref: z.string(),
        trustTier: z.literal('probabilistic'),
      }),
    )
    .optional(),
  /** Team-shared memory. */
  teamMem: z.array(z.string()).optional(),
});
export type ComprehensionMemoryLanes = z.infer<typeof ComprehensionMemoryLanesSchema>;

/** ECP payload — the actual comprehension data. */
export const ComprehensionPayloadSchema = z.object({
  literalGoal: z.string(),
  resolvedGoal: z.string(),
  state: ComprehensionStateSchema,
  priorContextSummary: z.string(),
  memoryLaneRelevance: ComprehensionMemoryLanesSchema,
});
export type ComprehensionPayload = z.infer<typeof ComprehensionPayloadSchema>;

/**
 * ECP envelope — the message shape that crosses engine→oracle→orchestrator
 * boundaries. Always validated at the boundary.
 *
 * `type: 'unknown'` is a valid outcome — do NOT throw when comprehension
 * fails. The orchestrator handles `unknown` by falling back to the literal
 * goal (graceful degradation, backwards-compatible).
 */
export const ComprehendedTaskMessageSchema = z.object({
  jsonrpc: z.literal('2.0'),
  method: z.literal('comprehension.result'),
  params: z.object({
    type: z.enum(['comprehension', 'unknown']),
    confidence: z.number().min(0).max(1),
    tier: ComprehensionTierSchema,
    evidence_chain: z.array(ComprehensionEvidenceSchema),
    falsifiable_by: z.array(z.string()),
    temporal_context: z.object({
      as_of: z.number(),
      valid_until: z.number().optional(),
    }),
    /**
     * Content-addressed binding (A4): SHA-256 of the canonical serialization
     * of (sessionId + conversation history tail + literal user message).
     * When any component changes, the comprehension auto-invalidates —
     * consumers keyed on inputHash get a fresh compute instead of stale cache.
     */
    inputHash: z.string(),
    /**
     * Root task goal — elevated to `params` (not only `data.state`) so
     * consumers can recompute the inputHash or key on rootGoal WITHOUT
     * parsing the full `data` payload. Matches the values in
     * `data.state.rootGoal` when `data` is present; independently null
     * for `type: 'unknown'`.
     */
    rootGoal: z.string().nullable(),
    /** Payload absent on `type: 'unknown'`. */
    data: ComprehensionPayloadSchema.optional(),
  }),
});
export type ComprehendedTaskMessage = z.infer<typeof ComprehendedTaskMessageSchema>;

// ── Engine contract ────────────────────────────────────────────────────

/** Structured input to a ComprehensionEngine. No LLM-specific surface. */
export interface ComprehensionInput {
  /** The task whose goal needs comprehending (raw user message in `goal`). */
  input: TaskInput;
  /**
   * Full conversation history for this session, in chronological order.
   * Already includes the user's latest message at the end when the
   * session manager has recorded it before dispatch — implementations
   * MUST NOT assume either ordering and should derive "prior turns" by
   * excluding the entry matching `input.goal`.
   */
  /** A7: Turn-model history replaces legacy ConversationEntry[]. */
  history: Turn[];
  /** Pending clarification questions from the last assistant turn (if any). */
  pendingQuestions: string[];
  /**
   * Root task goal for the current clarification chain. Null when this is
   * the start of a thread. Caller computes via SessionManager.getOriginalTaskGoal.
   */
  rootGoal: string | null;
  /**
   * Optional loaded user AutoMemory (~/.vinyan/memory/<slug>/MEMORY.md or
   * the Claude Code shared path). When present, the comprehender scans
   * each entry's keywords against the current goal/history and emits the
   * relevant entries in `memoryLaneRelevance.autoMem`. Entries ALWAYS
   * flow downstream tagged with `trustTier: 'probabilistic'` — never
   * promoted to deterministic/heuristic without explicit oracle
   * verification (Red Team #3).
   */
  autoMemory?: import('../../memory/auto-memory-loader.ts').AutoMemory | null;
}

/**
 * Engine-type discriminator — orthogonal to `tier`. The oracle uses this
 * to apply a per-type tier CEILING, so a rogue or misconfigured LLM
 * engine cannot claim `tier: 'deterministic'` at face value.
 *
 * Ceiling policy (enforced by `verifyComprehension`):
 *   - 'rule'      → up to `deterministic`   (rule-based, self-report trusted)
 *   - 'symbolic'  → up to `deterministic`   (solver / formal method)
 *   - 'hybrid'    → up to `heuristic`       (mixed — conservative)
 *   - 'llm'       → up to `probabilistic`   (LLM self-report NEVER trusted for deterministic/heuristic)
 *   - 'external'  → up to `probabilistic`   (out-of-process; unverified)
 */
export type ComprehensionEngineType = 'rule' | 'symbolic' | 'hybrid' | 'llm' | 'external';

/**
 * ComprehensionEngine — produces ECP-compliant comprehension messages from
 * structured input. Stateless; implementations may cache internally.
 *
 * Implementations:
 *   - rule-comprehender: deterministic, always available (P0)
 *   - llm-comprehender: probabilistic, circuit-breaker protected (P2)
 */
export interface ComprehensionEngine {
  /** Stable identifier used for logging, telemetry, and selection. */
  readonly id: string;
  /**
   * Engine type — orthogonal to `tier` and drives the oracle's per-type
   * tier ceiling (A5). Required so the orchestrator can impose an
   * independent trust bound rather than accepting the engine's own
   * `tier` claim uncritically.
   */
  readonly engineType: ComprehensionEngineType;
  /** Declared capabilities — e.g. ['comprehend.conversation']. */
  readonly capabilities: readonly string[];
  /** Advisory tier — upper bound for this engine's output trust. */
  readonly tier: ComprehensionTier;
  /**
   * Compute a comprehension for the given input. Must NOT throw for
   * ambiguous input — return `{ type: 'unknown', ... }` instead.
   */
  comprehend(input: ComprehensionInput): Promise<ComprehendedTaskMessage>;
}

/**
 * Tier rank for comparisons — higher = more trusted.
 * Matches the oracle's ordering in `verifyComprehension`.
 */
export function tierRank(tier: ComprehensionTier): number {
  switch (tier) {
    case 'deterministic': return 3;
    case 'heuristic': return 2;
    case 'probabilistic': return 1;
    case 'unknown': return 0;
  }
}

/** Max tier an engine of the given type is allowed to self-report. A5 ceiling. */
export function maxTierForEngineType(t: ComprehensionEngineType): ComprehensionTier {
  switch (t) {
    case 'rule':
    case 'symbolic':
      return 'deterministic';
    case 'hybrid':
      return 'heuristic';
    case 'llm':
    case 'external':
      return 'probabilistic';
  }
}

// ── Registry ───────────────────────────────────────────────────────────

/**
 * Minimal registry for comprehension engines. Kept domain-specific rather
 * than reusing the general ReasoningEngineRegistry because the latter is
 * prompt-centric (systemPrompt/userPrompt) and rule-based comprehension
 * doesn't fit that shape. If the two domains converge later, adapt via an
 * adapter — do not force-fit now.
 */
export class ComprehensionEngineRegistry {
  private engines = new Map<string, ComprehensionEngine>();

  register(engine: ComprehensionEngine): void {
    this.engines.set(engine.id, engine);
  }

  /** Return the first engine declaring the required capabilities. */
  selectByCapability(required: readonly string[]): ComprehensionEngine | undefined {
    for (const e of this.engines.values()) {
      if (required.every((c) => e.capabilities.includes(c))) return e;
    }
    return undefined;
  }

  /**
   * Select the best-available engine by tier preference. When the preferred
   * tier is unavailable, fall back to any engine declaring
   * `comprehend.conversation` — ensures the pipeline never hard-fails just
   * because the LLM engine is circuit-broken.
   */
  selectPreferredOrFallback(preferredTier: ComprehensionTier): ComprehensionEngine | undefined {
    for (const e of this.engines.values()) {
      if (e.tier === preferredTier && e.capabilities.includes('comprehend.conversation')) {
        return e;
      }
    }
    return this.selectByCapability(['comprehend.conversation']);
  }

  list(): readonly ComprehensionEngine[] {
    return Array.from(this.engines.values());
  }

  get(id: string): ComprehensionEngine | undefined {
    return this.engines.get(id);
  }
}

// ── Input-hash helper (A4) ─────────────────────────────────────────────

/**
 * Canonical hash of the comprehension input — binds the result to the exact
 * conversation snapshot that produced it. Cheap (SHA-256 of a stable string),
 * no crypto dependency beyond node's built-ins via Bun.
 */
export async function computeInputHash(input: ComprehensionInput): Promise<string> {
  const canonical = JSON.stringify({
    sessionId: input.input.sessionId ?? '',
    goal: input.input.goal,
    rootGoal: input.rootGoal ?? '',
    pending: input.pendingQuestions,
    // Hash only the last 10 turns — older context is compacted upstream.
    // A7: Turn-model shape — flatten text blocks for the hash.
    historyTail: input.history.slice(-10).map((h) => ({
      role: h.role,
      content: h.blocks
        .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
        .map((b) => b.text)
        .join('\n'),
      ts: h.createdAt,
    })),
  });
  // Bun exposes Web Crypto — no extra dependency.
  const bytes = new TextEncoder().encode(canonical);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
