/**
 * Built-in oracle evaluator for the role-protocol driver.
 *
 * The driver accepts a `StepOracleEvaluator` callback to keep the driver
 * pure. This module provides the canonical evaluator that knows how to
 * dispatch to Vinyan's built-in role-protocol oracles (Phase A2 ships
 * `source-citation`; later phases add `org-voice`, `trend-alignment`,
 * etc.).
 *
 * Stateful by design: a single evaluator instance is constructed per
 * protocol run. It captures the `gather` step's `evidence.hashes` array
 * so a downstream `verify-citations` step can resolve citation tokens
 * against it. Sharing state through evidence + closure keeps the
 * driver's `StepOracleEvaluator` signature minimal and testable.
 *
 * Convention for protocols:
 *   - gather step's `dispatch` MUST set `evidence.hashes: string[]` —
 *     each entry is a value the oracle compares citation-token
 *     resolutions against (URL, content hash, doi, …; format is
 *     opaque).
 *   - synthesize step's `dispatch` MUST set
 *     `evidence.synthesisText: string` (the body the verify-citations
 *     step inspects). The verify-citations step itself does not
 *     produce synthesisText — the body comes from the synthesize
 *     step's result, threaded through evidence on the verify step's
 *     dispatch.
 *
 * The convention is enforced via runtime warning, not type-system —
 * the evidence shape is `Record<string, unknown>` on `StepDispatchResult`
 * to keep the driver oracle-agnostic.
 */

import { verifySourceCitations } from '../../../oracle/role/source-citation/index.ts';
import type { RoleStep, StepDispatchResult, StepOracleEvaluator } from './types.ts';

export interface BuiltinOracleEvaluatorOptions {
  /**
   * Optional warning sink — invoked when the evaluator encounters a
   * declared oracle hook it does not know how to dispatch, or when an
   * expected evidence field is missing. Defaults to `console.warn`.
   * Tests inject a noop or a mock collector.
   */
  readonly onWarn?: (msg: string) => void;
}

/**
 * Build a `StepOracleEvaluator` keyed by oracle name. Stateful: the
 * returned function captures gather-step hashes so a later
 * verify-citations step can resolve against them. Construct one per
 * protocol run.
 *
 * Unknown oracle names are NOT recorded in the returned verdict map —
 * the driver treats absent entries as "not evaluated, no opinion," so a
 * mistyped hook name silently skips its check (with a warning). This is
 * permissive on purpose: a typo shouldn't break a protocol run, but the
 * warning makes the misconfiguration visible.
 */
export function buildBuiltinOracleEvaluator(opts: BuiltinOracleEvaluatorOptions = {}): StepOracleEvaluator {
  const warn = opts.onWarn ?? ((m) => console.warn(`[role-protocol] ${m}`));
  let gatheredHashes: ReadonlySet<string> = new Set();

  return async ({ step, result }) => {
    captureGatheredHashes(
      step,
      result,
      (hashes) => {
        gatheredHashes = hashes;
      },
      warn,
    );

    const verdicts: Record<string, boolean> = {};

    for (const hook of step.oracleHooks ?? []) {
      switch (hook.oracleName) {
        case 'source-citation': {
          const synthesisText = readSynthesisText(result, warn);
          const verdict = verifySourceCitations({ synthesisText, gatheredHashes });
          verdicts[hook.oracleName] = verdict.verified;
          break;
        }
        default:
          warn(`oracle "${hook.oracleName}" declared on step "${step.id}" but no handler registered`);
          break;
      }
    }

    return verdicts;
  };
}

function captureGatheredHashes(
  step: RoleStep,
  result: StepDispatchResult,
  set: (h: ReadonlySet<string>) => void,
  warn: (msg: string) => void,
): void {
  if (step.kind !== 'gather') return;
  const evidence = result.evidence as { readonly hashes?: unknown } | undefined;
  if (!evidence) {
    warn(`gather step "${step.id}" produced no evidence; downstream citation oracle will see empty set`);
    return;
  }
  if (!Array.isArray(evidence.hashes)) {
    warn(`gather step "${step.id}" evidence.hashes is missing or not an array; ignored`);
    return;
  }
  const hashes = new Set<string>();
  for (const h of evidence.hashes) {
    if (typeof h === 'string' && h.length > 0) hashes.add(h);
  }
  set(hashes);
}

function readSynthesisText(result: StepDispatchResult, warn: (msg: string) => void): string {
  const evidence = result.evidence as { readonly synthesisText?: unknown } | undefined;
  const text = evidence?.synthesisText;
  if (typeof text !== 'string') {
    warn('verify-citations step received no synthesisText evidence; oracle will see empty input');
    return '';
  }
  return text;
}
