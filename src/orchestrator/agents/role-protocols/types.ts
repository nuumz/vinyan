/**
 * RoleProtocol — Phase A1 type definitions.
 *
 * A `RoleProtocol` is the *workflow contract* a persona enforces when
 * embodying its role. Where `Persona.soul` is identity (cosmetic prompt
 * influence), `RoleProtocol` is methodology (orchestrator-enforced step
 * sequence + per-step oracle hooks + exit criteria).
 *
 * Three orthogonal axes:
 *   - Persona            — identity + ACL + soul (existing)
 *   - **RoleProtocol**   — ordered steps + oracle hooks + exit (this module)
 *   - DomainPack (skill) — tools + sources (existing)
 *
 * A1-honest separation: a `verify`-kind step inside a researcher protocol
 * MUST be dispatched to a verifier-class persona, not the researcher
 * itself. The `requiresPersonaClass` field on each step communicates that
 * to the dispatcher — actual routing is the caller's responsibility, not
 * the driver's. The driver only enforces that no step runs against a
 * persona of the wrong class (fail-closed when violated).
 *
 * Phase A1 is the inert framework: types, registry, driver, and
 * phase-generate routing exist but no built-in persona declares a
 * `roleProtocolId`. Phase A2 fills the framework with the
 * `researcher.investigate` protocol + `source-citation` oracle.
 */

import type { PersonaClass } from '../persona-class.ts';

/** Branded id for a role protocol. Distinct from `PersonaId` (RFC §5). */
// biome-ignore lint/style/useNamingConvention: nominal type brand convention
export type RoleProtocolId = string & { readonly __brand: 'RoleProtocolId' };

/** Construct a branded `RoleProtocolId`. Validates lowercase + dot-namespaced. */
export function makeRoleProtocolId(raw: string): RoleProtocolId {
  if (!/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(raw)) {
    throw new Error(
      `Invalid RoleProtocolId "${raw}": must be lowercase dot-namespaced (e.g. 'researcher.investigate').`,
    );
  }
  return raw as RoleProtocolId;
}

/**
 * The kind of cognitive work a step performs. Mirrors the high-level
 * verbs a researcher / secretary / content-creator walks through.
 *
 * `verify` is special: it *must* run on a Verifier-class persona to
 * preserve A1 separation. The driver fails-closed if a `verify` step is
 * executed against a Generator-class persona.
 */
export type StepKind = 'discover' | 'gather' | 'analyze' | 'synthesize' | 'verify' | 'deliver' | 'custom';

/** Oracle hook — declared per step, evaluated by the caller post-dispatch. */
export interface OracleHook {
  /** Registry name of the oracle (e.g. `'source-citation'`). */
  readonly oracleName: string;
  /**
   * When true, a negative verdict marks the step as failed and the driver
   * advances no further (subject to `RoleStep.retryMax`). When false the
   * verdict is recorded for audit but does not gate progression.
   */
  readonly blocking: boolean;
  /** Per-hook timeout. Falls back to oracle's default when omitted. */
  readonly timeoutMs?: number;
}

/**
 * A single step in a protocol. Steps run in declaration order, subject to
 * `preconditions` (ids of steps that must have completed cleanly first).
 */
export interface RoleStep {
  /** Step id, unique within a protocol (e.g. `'discover'`, `'gather'`). */
  readonly id: string;
  readonly kind: StepKind;
  /** One-sentence description for trace + audit consumers. */
  readonly description: string;
  /**
   * Prompt fragment prepended to the persona's soul when this step
   * dispatches. Intentionally narrow — no full system-prompt rewrite, the
   * persona's identity must remain intact.
   */
  readonly promptPrepend: string;
  /** Step ids that must have completed (`outcome === 'success'`) first. */
  readonly preconditions?: readonly string[];
  readonly oracleHooks?: readonly OracleHook[];
  /**
   * When set, restricts the step's `targetFiles` to the file set recorded
   * by another step's evidence (typically `'gather'`'s output for an
   * `'analyze'` step). The driver passes this restriction to the caller's
   * `dispatchUnderlying`; the caller is responsible for honoring it.
   */
  readonly targetFilesFromStep?: string;
  /** Max retry attempts on blocking-oracle failure (default 0 — fail-fast). */
  readonly retryMax?: number;
  /**
   * A1 honesty contract. When set, the driver fails-closed if the
   * dispatching persona's class does not match.
   *
   * Typical use: a `verify` step inside a researcher protocol declares
   * `'verifier'`; the orchestrator must route that step to a reviewer
   * persona, not back to the researcher.
   */
  readonly requiresPersonaClass?: PersonaClass;
}

/**
 * Exit criterion — evaluated after each step to decide whether the
 * protocol may terminate early. Multiple criteria are AND-ed (all must
 * hold). The protocol always terminates after the last step, regardless.
 */
export type ExitCriterion =
  | { readonly kind: 'evidence-confidence'; readonly threshold: number }
  | { readonly kind: 'oracle-pass'; readonly oracleName: string }
  | { readonly kind: 'step-count'; readonly minSteps: number };

/**
 * The protocol record itself. Immutable; registered once, looked up by
 * id at task-resolve time.
 */
export interface RoleProtocol {
  readonly id: RoleProtocolId;
  readonly description: string;
  /**
   * The orchestrator-class this protocol is designed to drive. The
   * persona that owns the *whole task* must match this class. Per-step
   * overrides via `RoleStep.requiresPersonaClass` are still honored.
   */
  readonly requiresPersonaClass?: PersonaClass;
  readonly steps: readonly RoleStep[];
  readonly exitCriteria?: readonly ExitCriterion[];
}

// ── Driver-facing run types ───────────────────────────────────────────────

/**
 * Result of a single step's underlying dispatch. The driver passes this to
 * the caller's oracle evaluator and accumulates it in `RoleProtocolRunResult`.
 */
export interface StepDispatchResult {
  /** File mutations produced by the step (may be empty for read-only steps). */
  readonly mutations: ReadonlyArray<{
    readonly file: string;
    readonly content: string;
    readonly explanation?: string;
  }>;
  /** Free-form evidence the caller wants the driver to record (oracle-readable). */
  readonly evidence?: Readonly<Record<string, unknown>>;
  /** Aggregate confidence the dispatcher reports for this step's output (0..1). */
  readonly confidence?: number;
  readonly tokensConsumed: number;
  readonly durationMs: number;
}

/** Outcome assigned to a step after dispatch + oracle evaluation. */
export type StepOutcome = 'success' | 'failure' | 'skipped' | 'oracle-blocked';

export interface StepRunRecord {
  readonly stepId: string;
  readonly kind: StepKind;
  readonly outcome: StepOutcome;
  readonly attempts: number;
  readonly evidence?: Readonly<Record<string, unknown>>;
  readonly confidence?: number;
  readonly tokensConsumed: number;
  readonly durationMs: number;
  /** Human-readable reason for non-success outcomes. */
  readonly reason?: string;
  /** Oracle-name → pass/fail map for blocking + non-blocking hooks alike. */
  readonly oracleVerdicts?: Readonly<Record<string, boolean>>;
}

export interface RoleProtocolRunResult {
  readonly protocolId: RoleProtocolId;
  readonly steps: readonly StepRunRecord[];
  readonly outcome: 'success' | 'partial' | 'failure';
  /** Set when the driver short-circuits via an exit criterion. */
  readonly exitedEarly?: boolean;
  readonly totalTokensConsumed: number;
  readonly totalDurationMs: number;
  /** Aggregate confidence across all `success` steps (mean of step confidence). */
  readonly aggregateConfidence?: number;
}

/**
 * Caller-injected callback. Given a step, produces the dispatch result.
 * The driver does NOT touch the orchestrator directly — keeping the
 * driver pure makes it independently testable and lets the same driver
 * back single-shot, agentic-loop, and Agent-Conversation-Room paths.
 */
export type StepDispatchCallback = (input: {
  readonly step: RoleStep;
  readonly promptPrepend: string;
  readonly targetFiles?: readonly string[];
}) => Promise<StepDispatchResult>;

/**
 * Caller-injected oracle evaluator. Given a step + its dispatch result,
 * returns the oracle verdicts (oracle-name → pass). The driver consults
 * `RoleStep.oracleHooks` to know which hooks are blocking. When omitted,
 * the driver assumes every declared oracle passed — useful for tests
 * and the Phase A1 inert MVP where no oracles are wired yet.
 */
export type StepOracleEvaluator = (input: {
  readonly step: RoleStep;
  readonly result: StepDispatchResult;
}) => Promise<Readonly<Record<string, boolean>>>;
