/**
 * CLI oracle stubs — minimal drop-ins that let the W3 consumer CLI
 * (`vinyan schedule`, `vinyan skills import`) run end-to-end before the
 * real orchestrator-factory oracles are threaded through.
 *
 * These stubs exist so the CLI is functional today; they are intentionally
 * permissive and MUST be replaced before these commands are used as the
 * primary authorization path. Every function here carries a `TODO(w4)`
 * pointing to the real integration so the swap is a one-line change.
 *
 * Axiom note: A1 Epistemic Separation is weakened while these stubs are
 * wired — the CLI accepts its own proposals. This is acceptable only
 * because the existing factory wiring (`src/orchestrator/factory.ts`) is
 * the production path; the CLI is developer-facing.
 */
import type {
  ImporterCriticFn,
  ImporterCriticRequest,
  ImporterCriticVerdict,
  ImporterGateFn,
  ImporterGateRequest,
  ImporterGateVerdict,
} from '../skills/hub/importer.ts';

/** Result shape for the H3 interpreter's goal-alignment oracle dep. */
export interface StubGoalAlignmentResult {
  readonly confidence: number;
  readonly aligned: boolean;
}

/** Input shape the interpreter hands the goal-alignment oracle. */
export interface StubGoalAlignmentRequest {
  readonly goal: string;
  readonly nlOriginal: string;
}

/**
 * TODO(w4): replace with the real goal-alignment oracle from
 * `src/oracle/goal-alignment/`. This stub always returns
 * `{ confidence: 0.8, aligned: true }` so `vinyan schedule` can parse and
 * persist a schedule before the full oracle pipeline is plumbed into the
 * CLI. The real oracle compares the derived goal against the user's
 * natural-language input and returns a calibrated confidence.
 *
 * Safe to use: CLI-only contexts where the user is interactively creating a
 * schedule. NOT safe to use: production ingress, federated instances, or
 * any automated path that could submit untrusted NL.
 */
export function stubGoalAlignmentOracle(): (req: StubGoalAlignmentRequest) => Promise<StubGoalAlignmentResult> {
  return async (_req) => ({ confidence: 0.8, aligned: true });
}

/**
 * TODO(w4): replace with the real runGate adapter via
 * `src/skills/hub/gate-adapter.ts` and a configured `OracleGate`.
 *
 * This stub returns an `allow` verdict with an `allow` epistemic decision
 * and aggregate confidence 0.85, matching the verdict the hub promotion
 * rule expects when a skill passes its dry-run gate. This is enough to let
 * `vinyan skills import` walk the full state machine end-to-end; real
 * verification only starts once the factory wiring is hooked in.
 */
export function stubImporterGateFn(): ImporterGateFn {
  return async (_req: ImporterGateRequest): Promise<ImporterGateVerdict> => ({
    decision: 'allow',
    epistemicDecision: 'allow',
    aggregateConfidence: 0.85,
    reasons: [],
  });
}

/**
 * TODO(w4): replace with the real critic adapter via
 * `src/skills/hub/critic-adapter.ts` and a configured `CriticEngine`.
 *
 * Returns `approved: true` at confidence 0.9 so the promotion rule will
 * allow a clean skill through to the `promoted` state. Pairs with
 * {@link stubImporterGateFn}.
 */
export function stubImporterCriticFn(): ImporterCriticFn {
  return async (_req: ImporterCriticRequest): Promise<ImporterCriticVerdict> => ({
    approved: true,
    confidence: 0.9,
    notes: 'cli-stub: critic not yet wired — see TODO(w4)',
  });
}
