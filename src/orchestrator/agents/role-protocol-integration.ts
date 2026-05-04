/**
 * Role-protocol orchestration integration — Phase A2.5 wiring helper.
 *
 * The `RoleProtocolDriver` is intentionally pure: it accepts a
 * `dispatchUnderlying` callback and an `oracleEvaluator` callback,
 * runs steps, returns a `RoleProtocolRunResult`. This module provides
 * the canonical adapters that bridge the driver to:
 *
 *   1. The orchestrator's `WorkerPool.dispatch` (per-step dispatch)
 *   2. The `RoleProtocolRunStore` audit table (per-step persistence)
 *   3. The built-in oracle evaluator (already in
 *      `agents/role-protocols/oracle-evaluator.ts`)
 *
 * Keeping this glue out of the driver itself preserves the driver's
 * testability and reusability — the same driver runs from L0/L1
 * single-shot dispatch (this module), L2+ agent-loop (A2.6), or test
 * fixtures (no glue at all).
 *
 * Per-step evidence extraction:
 *   - `gather` step: parse `{"hashes": [...]}` JSON from the LLM's
 *     `proposedContent`; populate `evidence.hashes`.
 *   - `synthesize` step: forward `proposedContent` verbatim as
 *     `evidence.synthesisText` so the oracle evaluator captures it.
 *   - other steps: empty evidence (the driver doesn't currently use
 *     evidence from non-gather/non-synthesize steps).
 *
 * The evidence parser is permissive — JSON parse failures fall back to
 * an empty hashes set, which causes the source-citation oracle to
 * report every citation as `not-in-gathered-set` and the verify step
 * to be `oracle-blocked`. That's the correct degraded behavior: a
 * researcher that can't structure their gather output cannot pass
 * verification, surfacing the failure in the audit trail instead of
 * silently passing.
 */

import type { VinyanBus } from '../../core/bus.ts';
import type { RoleProtocolRunStore } from '../../db/role-protocol-run-store.ts';
import type { WorkerResult } from '../phases/types.ts';
import type { TaskInput } from '../types.ts';
import type {
  RoleProtocolRunResult,
  StepDispatchCallback,
  StepDispatchResult,
  StepKind,
  StepRunRecord,
} from './role-protocols/types.ts';

export interface DispatchUnderlyingDeps {
  /**
   * Per-step worker dispatch. Receives a fully-augmented `TaskInput`
   * (with `systemPromptAugmentation` set to the step's `promptPrepend`)
   * and returns a `WorkerResult`. The integration maps `WorkerResult` →
   * `StepDispatchResult` for the driver.
   *
   * The callback shape mirrors `workerPool.dispatch` minus the contract
   * + ancillary args, which the integration captures via closure.
   */
  readonly perStepDispatch: (stepInput: TaskInput) => Promise<WorkerResult>;
}

/**
 * Build the `dispatchUnderlying` callback the driver consumes. The
 * returned callback per-step:
 *
 *   1. Clones the parent task input and stamps a step-scoped `id`
 *      (`<parent>-<stepId>`) so the worker pool's own per-task tracking
 *      doesn't collide with the parent task's ledger entries.
 *   2. Sets `systemPromptAugmentation` to the step's `promptPrepend`
 *      so the worker's assembled system prompt prepends the step's
 *      methodology.
 *   3. Awaits the parent caller's `perStepDispatch` (typically
 *      `workerPool.dispatch`).
 *   4. Maps the `WorkerResult` to a `StepDispatchResult`, extracting
 *      structured evidence from `proposedContent` per the step's kind.
 */
export function buildDispatchUnderlying(parent: TaskInput, deps: DispatchUnderlyingDeps): StepDispatchCallback {
  return async ({ step, promptPrepend }) => {
    const stepInput: TaskInput = {
      ...parent,
      id: `${parent.id}-${step.id}`,
      systemPromptAugmentation: promptPrepend,
    };
    const wr = await deps.perStepDispatch(stepInput);
    return mapWorkerResultToStepDispatchResult(step.kind, wr);
  };
}

/**
 * Map a `WorkerResult` (from `workerPool.dispatch`) into the driver's
 * `StepDispatchResult` shape. Extract step-kind-specific evidence so
 * the oracle evaluator and downstream steps can read it.
 */
export function mapWorkerResultToStepDispatchResult(stepKind: StepKind, wr: WorkerResult): StepDispatchResult {
  return {
    mutations: wr.mutations.map((m) => ({
      file: m.file,
      content: m.content,
      explanation: m.explanation,
    })),
    evidence: extractStepEvidence(stepKind, wr.proposedContent),
    // Worker doesn't produce per-step confidence; phase-verify will compute
    // verification confidence on the aggregate. Leave undefined here —
    // exit-criterion `evidence-confidence` thresholds won't fire from L0/L1
    // runs of researcher.investigate (the protocol's only exit criterion is
    // oracle-pass + step-count, both of which are populated correctly).
    tokensConsumed: wr.tokensConsumed,
    durationMs: wr.durationMs,
  };
}

/**
 * Extract step-kind-specific evidence from the LLM's free-form
 * `proposedContent`. Permissive parsing: malformed JSON for a `gather`
 * step yields empty hashes (which causes downstream verification to
 * fail clearly) rather than crashing the run.
 */
export function extractStepEvidence(
  stepKind: StepKind,
  proposedContent: string | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (!proposedContent) return undefined;
  if (stepKind === 'synthesize') {
    return { synthesisText: proposedContent };
  }
  if (stepKind === 'gather') {
    const hashes = parseHashesFromContent(proposedContent);
    return hashes ? { hashes } : { hashes: [] };
  }
  if (stepKind === 'verify') {
    // Verify step's own content is typically empty (the oracle does the
    // work) — but if the LLM wrote anything, capture it for audit.
    return { verifyNote: proposedContent };
  }
  return undefined;
}

/**
 * Best-effort parse of a `{"hashes": [...]}` block from `proposedContent`.
 * Accepts the JSON anywhere in the body — the LLM may surround it with
 * prose. Returns `null` when no parseable hash array is found.
 */
function parseHashesFromContent(content: string): readonly string[] | null {
  // Find the first `{"hashes":` substring, then attempt to parse from
  // the surrounding `{`. Bracket-balance-aware to avoid overshooting.
  const marker = content.indexOf('"hashes"');
  if (marker < 0) return null;

  // Walk back to the nearest `{`
  let openIdx = marker;
  while (openIdx > 0 && content[openIdx] !== '{') openIdx--;
  if (content[openIdx] !== '{') return null;

  // Walk forward, tracking balance, to find the matching `}`
  let depth = 0;
  let endIdx = -1;
  for (let i = openIdx; i < content.length; i++) {
    const c = content[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        endIdx = i;
        break;
      }
    }
  }
  if (endIdx < 0) return null;

  try {
    const parsed = JSON.parse(content.slice(openIdx, endIdx + 1)) as unknown;
    if (!parsed || typeof parsed !== 'object' || !('hashes' in parsed)) return null;
    const hashes = (parsed as { hashes: unknown }).hashes;
    if (!Array.isArray(hashes)) return null;
    const cleaned = hashes.filter((h): h is string => typeof h === 'string' && h.length > 0);
    return cleaned;
  } catch {
    return null;
  }
}

// ── Persistence ───────────────────────────────────────────────────────────

export interface PersistRunResultDeps {
  readonly store: RoleProtocolRunStore;
  readonly bus?: VinyanBus | undefined;
  readonly taskId: string;
  readonly personaId: string;
  readonly clock?: () => number;
}

/**
 * Persist every `StepRunRecord` in `result` to the audit store. One row
 * per step. Emits `'role-protocol:run_complete'` on the bus when a
 * subscriber is attached (operator dashboards, observability) — Phase
 * A2.5 doesn't require a typed bus event yet; emit through the existing
 * `'role-protocol:resolved'` topic family if the bus is given. For now,
 * just write rows.
 */
export function persistRunResult(deps: PersistRunResultDeps, result: RoleProtocolRunResult): void {
  const clock = deps.clock ?? Date.now;
  for (const [index, step] of result.steps.entries()) {
    persistStepRecord(deps.store, deps.taskId, deps.personaId, result.protocolId, index, step, clock());
  }
}

function persistStepRecord(
  store: RoleProtocolRunStore,
  taskId: string,
  personaId: string,
  protocolId: string,
  stepIndex: number,
  step: StepRunRecord,
  startedAt: number,
): void {
  store.recordStep({
    taskId,
    personaId,
    protocolId,
    stepId: step.stepId,
    stepIndex,
    outcome: step.outcome,
    attempts: step.attempts,
    confidence: step.confidence ?? null,
    tokensConsumed: step.tokensConsumed,
    durationMs: step.durationMs,
    reason: step.reason ?? null,
    oracleVerdicts: step.oracleVerdicts ?? null,
    evidence: step.evidence ?? null,
    startedAt,
  });
}

/**
 * Aggregate a `RoleProtocolRunResult` back into a single `WorkerResult`
 * shape so phase-generate can return its existing contract to the rest
 * of the pipeline (phase-verify, phase-learn, etc.). The synthesize
 * step's `proposedContent` becomes the user-visible answer. Tokens +
 * duration sum across all dispatched steps.
 *
 * When the protocol failed before reaching synthesize, `proposedContent`
 * is the last step's evidence stringification — at least surfaces *why*
 * the protocol stopped to the user.
 */
export function aggregateRunToWorkerResult(result: RoleProtocolRunResult): WorkerResult {
  const synthesizeStep = result.steps.find((s) => s.kind === 'synthesize' && s.outcome === 'success');
  const synthesisText =
    (synthesizeStep?.evidence as { readonly synthesisText?: string } | undefined)?.synthesisText ?? '';

  // Mutations are the union of every step's mutations. For a typical research
  // task there are zero — research is a read-only domain. Code-mutating
  // protocols (future) would aggregate here.
  const mutations: WorkerResult['mutations'] = [];

  return {
    mutations,
    proposedToolCalls: [],
    tokensConsumed: result.totalTokensConsumed,
    durationMs: result.totalDurationMs,
    proposedContent: synthesisText.length > 0 ? synthesisText : aggregateFailureSummary(result),
  };
}

function aggregateFailureSummary(result: RoleProtocolRunResult): string {
  const failed = result.steps.find((s) => s.outcome !== 'success');
  if (!failed) return '';
  return `[role-protocol ${result.protocolId}] step "${failed.stepId}" outcome=${failed.outcome}: ${failed.reason ?? '(no reason recorded)'}`;
}
