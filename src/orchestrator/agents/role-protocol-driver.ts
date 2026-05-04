/**
 * RoleProtocolDriver — Phase A1 orchestration-layer driver.
 *
 * Wraps the existing dispatch path (`workerPool.dispatch` for L0/L1,
 * `runAgentLoop` for L2+) with per-step prompt overrides + blocking
 * oracle hooks. The driver is **not** a `ReasoningEngine` (see
 * `docs/design/persona-role-embodiment-plan.md` §5 / plan §5):
 * `ReasoningEngine.execute()` is single-shot, but a protocol coordinates
 * multiple dispatches with state between, and a `verify` step must
 * dispatch to a different persona class than the prior `synthesize`.
 *
 * The driver is **pure**: it takes
 *   1. a registered `RoleProtocol`,
 *   2. a `dispatchUnderlying` callback (caller wires this to whichever
 *      dispatch path is appropriate for the routing level), and
 *   3. an optional `oracleEvaluator` (Phase A2 wires the source-citation
 *      oracle here; Phase A1 default is "every declared oracle passes").
 *
 * Phase A1 ships the framework as inert: no built-in persona declares a
 * `roleProtocolId`, so phase-generate's branch is dead in production.
 * Tests exercise the driver directly with stubbed dispatch.
 *
 * A1 honesty: a step with `requiresPersonaClass` set fails-closed when
 * the dispatching persona's class does not match. The driver never
 * tries to "rescue" by silently routing elsewhere — that would lie about
 * who produced the artifact.
 */

import type { AgentSpec } from '../types.ts';
import { type PersonaClass, personaClassOf } from './persona-class.ts';
import { getRoleProtocol } from './role-protocols/registry.ts';
import type {
  ExitCriterion,
  RoleProtocol,
  RoleProtocolRunResult,
  RoleStep,
  StepDispatchCallback,
  StepDispatchResult,
  StepOracleEvaluator,
  StepOutcome,
  StepRunRecord,
} from './role-protocols/types.ts';

export interface RoleProtocolResolveInput {
  /** The persona that owns this task. Source of class for A1 checks. */
  readonly persona: AgentSpec;
  /**
   * Optional explicit override — caller (e.g. CLI / API) may pin a
   * protocol id for one task. Wins over the persona's default.
   */
  readonly overrideProtocolId?: string;
  /**
   * Hint that the task is conversational. Conversational tasks bypass
   * protocols entirely (R1 mitigation per plan §9) so a researcher
   * persona answering a one-line "what time is it?" doesn't walk a
   * 6-step investigation protocol.
   */
  readonly isConversational?: boolean;
}

export interface RoleProtocolRunOptions {
  readonly protocol: RoleProtocol;
  readonly persona: AgentSpec;
  readonly dispatch: StepDispatchCallback;
  readonly oracleEvaluator?: StepOracleEvaluator;
  /** Wall-clock budget shared across all steps. Driver fails-closed on overrun. */
  readonly maxDurationMs?: number;
  /**
   * Phase A3 — when set, replaces the threshold of every
   * `evidence-confidence` exit criterion in `protocol.exitCriteria`.
   * Lets operators tune exit aggressiveness via `ParameterStore`
   * (`role.exit.confidence_floor`) without rewriting the protocol.
   * Protocol-declared thresholds are used when this is undefined.
   */
  readonly exitConfidenceFloorOverride?: number;
  /**
   * Phase A3 — fallback `retryMax` for steps that don't declare one.
   * Default 0 (fail-fast on first blocking-oracle failure). Operators
   * raise it via `ParameterStore` (`role.step.retry_max`) when they want
   * the protocol to give the dispatcher a second swing on flaky steps.
   * A step's explicit `retryMax` always wins over this default.
   */
  readonly defaultRetryMax?: number;
}

export class RoleProtocolDriver {
  /**
   * Resolve which protocol (if any) should run for this persona+task.
   * Deterministic, A3-safe — no LLM in the path. Returns `null` to mean
   * "bypass driver, use legacy dispatch."
   *
   * Resolution order (first hit wins):
   *   1. `overrideProtocolId` — explicit pin from caller.
   *   2. `persona.roleProtocolId` — the persona's default.
   *   3. `null` — no protocol, legacy dispatch.
   *
   * Returns `null` when the protocol exists but doesn't match the
   * persona's class (misconfig — fall through to legacy rather than
   * fail-closed at resolve time, since the legacy path still works).
   */
  resolve(input: RoleProtocolResolveInput): RoleProtocol | null {
    if (input.isConversational) return null;

    const id = input.overrideProtocolId ?? input.persona.roleProtocolId;
    if (!id) return null;

    const protocol = getRoleProtocol(id);
    if (!protocol) return null;

    if (protocol.requiresPersonaClass) {
      const personaClass = personaClassOf(input.persona.role);
      if (!classMatches(personaClass, protocol.requiresPersonaClass)) {
        return null;
      }
    }
    return protocol;
  }

  /**
   * Drive the protocol to completion (or early exit). Caller provides
   * the underlying dispatch + (optionally) the oracle evaluator.
   *
   * Steps run in declaration order. A step is `'skipped'` when any of
   * its preconditions did not produce a `'success'` outcome. A step
   * fails-closed (`'oracle-blocked'`) when a blocking oracle hook
   * returns `false`; the driver retries up to `step.retryMax` times
   * before propagating the failure outcome.
   *
   * The protocol's exit criteria are evaluated after each successful
   * step; meeting them sets `exitedEarly: true` and stops the loop.
   */
  async run(opts: RoleProtocolRunOptions): Promise<RoleProtocolRunResult> {
    const { protocol, persona, dispatch, oracleEvaluator, maxDurationMs } = opts;
    const personaClass = personaClassOf(persona.role);
    const records: StepRunRecord[] = [];
    const completedSuccessfully = new Set<string>();
    const startTs = Date.now();
    let totalTokens = 0;
    let totalDuration = 0;
    let exitedEarly = false;

    for (let stepIdx = 0; stepIdx < protocol.steps.length; stepIdx++) {
      const step = protocol.steps[stepIdx]!;
      // Budget — fail-closed (A6) when the wall-clock cap is exceeded.
      if (maxDurationMs !== undefined && Date.now() - startTs > maxDurationMs) {
        records.push(makeRecord(step, 'skipped', 0, 0, 0, undefined, undefined, undefined, 'budget exhausted'));
        continue;
      }

      // A1 honesty — a verifier-class step on a generator persona is a hard fail.
      if (step.requiresPersonaClass && !classMatches(personaClass, step.requiresPersonaClass)) {
        records.push(
          makeRecord(
            step,
            'failure',
            0,
            0,
            0,
            undefined,
            undefined,
            undefined,
            `step requires ${step.requiresPersonaClass} class but persona "${persona.id}" is ${personaClass}`,
          ),
        );
        continue;
      }

      // Preconditions: every prerequisite must have completed successfully.
      const missingPre = (step.preconditions ?? []).filter((p) => !completedSuccessfully.has(p));
      if (missingPre.length > 0) {
        records.push(
          makeRecord(
            step,
            'skipped',
            0,
            0,
            0,
            undefined,
            undefined,
            undefined,
            `unmet precondition(s): ${missingPre.join(', ')}`,
          ),
        );
        continue;
      }

      // Step retry loop — `attempts` always counts at least 1.
      // A3 plumbing: step's own retryMax wins; otherwise the run-options
      // default (which the orchestrator wires to ParameterStore's
      // `role.step.retry_max`); otherwise 0 (fail-fast).
      const effectiveRetryMax = step.retryMax ?? opts.defaultRetryMax ?? 0;
      const maxAttempts = effectiveRetryMax + 1;
      let attempt = 0;
      let final: StepRunRecord | undefined;

      while (attempt < maxAttempts) {
        attempt++;
        const dispatchResult = await dispatch({
          step,
          promptPrepend: step.promptPrepend,
          targetFiles: undefined, // A2 will resolve targetFilesFromStep against accumulated evidence.
        });
        totalTokens += dispatchResult.tokensConsumed;
        totalDuration += dispatchResult.durationMs;

        const verdicts = await evaluateOracles(step, dispatchResult, oracleEvaluator);
        const blockingFailed = (step.oracleHooks ?? [])
          .filter((h) => h.blocking)
          .find((h) => verdicts[h.oracleName] === false);

        if (blockingFailed) {
          if (attempt >= maxAttempts) {
            final = makeRecord(
              step,
              'oracle-blocked',
              attempt,
              dispatchResult.tokensConsumed,
              dispatchResult.durationMs,
              dispatchResult.evidence,
              dispatchResult.confidence,
              verdicts,
              `blocking oracle "${blockingFailed.oracleName}" failed after ${attempt} attempt(s)`,
            );
            break;
          }
          continue; // retry
        }

        final = makeRecord(
          step,
          'success',
          attempt,
          dispatchResult.tokensConsumed,
          dispatchResult.durationMs,
          dispatchResult.evidence,
          dispatchResult.confidence,
          verdicts,
        );
        completedSuccessfully.add(step.id);
        break;
      }

      records.push(final!);

      // Early-exit evaluation — only after a successful step that is not
      // the last one (otherwise we'd flag a normal terminal exit as
      // "early," which lies about the protocol's progression).
      const isLastStep = stepIdx === protocol.steps.length - 1;
      if (
        !isLastStep &&
        final?.outcome === 'success' &&
        shouldExitEarly(protocol.exitCriteria, records, completedSuccessfully, opts.exitConfidenceFloorOverride)
      ) {
        exitedEarly = true;
        break;
      }
    }

    const successRecords = records.filter((r) => r.outcome === 'success');
    const aggregateConfidence = computeAggregateConfidence(successRecords);
    const overall = computeOverallOutcome(records);

    return {
      protocolId: protocol.id,
      steps: records,
      outcome: overall,
      ...(exitedEarly ? { exitedEarly: true } : {}),
      totalTokensConsumed: totalTokens,
      totalDurationMs: totalDuration,
      ...(aggregateConfidence !== undefined ? { aggregateConfidence } : {}),
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function classMatches(personaClass: PersonaClass, requirement: PersonaClass): boolean {
  if (personaClass === requirement) return true;
  // `mixed` personas can fulfil either requirement — they intentionally
  // straddle the divide. Generator/verifier never substitute for each other.
  if (personaClass === 'mixed') return true;
  return false;
}

async function evaluateOracles(
  step: RoleStep,
  result: StepDispatchResult,
  evaluator: StepOracleEvaluator | undefined,
): Promise<Readonly<Record<string, boolean>>> {
  // When an evaluator is provided, always call it — even for steps that
  // declare no hooks. The evaluator is the seam by which an integration
  // (e.g. the built-in evaluator capturing the gather step's hashes for
  // a downstream verify-citations check) accumulates per-run state.
  // Returning early on empty hooks would deny the evaluator visibility
  // of intermediate steps. The evaluator is responsible for returning
  // `{}` when it has no opinion on the current step's hooks.
  if (evaluator) return evaluator({ step, result });

  // A1 inert default — every declared oracle passes. Used by tests that
  // do not need a real evaluator and by the framework before A2 wires
  // the built-in evaluator into production paths.
  if (!step.oracleHooks || step.oracleHooks.length === 0) return {};
  const passed: Record<string, boolean> = {};
  for (const hook of step.oracleHooks) passed[hook.oracleName] = true;
  return passed;
}

function makeRecord(
  step: RoleStep,
  outcome: StepOutcome,
  attempts: number,
  tokensConsumed: number,
  durationMs: number,
  evidence: Readonly<Record<string, unknown>> | undefined,
  confidence: number | undefined,
  oracleVerdicts: Readonly<Record<string, boolean>> | undefined,
  reason?: string,
): StepRunRecord {
  return {
    stepId: step.id,
    kind: step.kind,
    outcome,
    attempts,
    ...(evidence ? { evidence } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    tokensConsumed,
    durationMs,
    ...(reason ? { reason } : {}),
    ...(oracleVerdicts && Object.keys(oracleVerdicts).length > 0 ? { oracleVerdicts } : {}),
  };
}

function shouldExitEarly(
  criteria: readonly ExitCriterion[] | undefined,
  records: readonly StepRunRecord[],
  completedSuccessfully: ReadonlySet<string>,
  exitConfidenceFloorOverride: number | undefined,
): boolean {
  if (!criteria || criteria.length === 0) return false;

  for (const criterion of criteria) {
    switch (criterion.kind) {
      case 'evidence-confidence': {
        const conf = computeAggregateConfidence(records.filter((r) => r.outcome === 'success'));
        // A3 plumbing: operator override (from ParameterStore
        // `role.exit.confidence_floor`) replaces the protocol's
        // declared threshold when set.
        const threshold = exitConfidenceFloorOverride ?? criterion.threshold;
        if (conf === undefined || conf < threshold) return false;
        break;
      }
      case 'oracle-pass': {
        const anyPass = records.some((r) => r.oracleVerdicts?.[criterion.oracleName] === true);
        if (!anyPass) return false;
        break;
      }
      case 'step-count': {
        if (completedSuccessfully.size < criterion.minSteps) return false;
        break;
      }
    }
  }
  return true;
}

function computeAggregateConfidence(successRecords: readonly StepRunRecord[]): number | undefined {
  const withConf = successRecords.filter(
    (r): r is StepRunRecord & { confidence: number } => r.confidence !== undefined,
  );
  if (withConf.length === 0) return undefined;
  const sum = withConf.reduce((a, r) => a + r.confidence, 0);
  return sum / withConf.length;
}

function computeOverallOutcome(records: readonly StepRunRecord[]): 'success' | 'partial' | 'failure' {
  if (records.length === 0) return 'failure';
  const allSuccess = records.every((r) => r.outcome === 'success');
  if (allSuccess) return 'success';
  const anySuccess = records.some((r) => r.outcome === 'success');
  return anySuccess ? 'partial' : 'failure';
}
