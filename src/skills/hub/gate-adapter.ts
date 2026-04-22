/**
 * Gate adapter — bridges the `SkillImporter`'s narrow `ImporterGateFn` shape
 * to the real `runGate(request)` surface from `src/gate/gate.ts`.
 *
 * The importer doesn't own a full `GateRequest`; it hands us a skill-focused
 * call shape (tool, file_path, content, workspace, skillId). This adapter
 * synthesizes a minimal, dry-run-safe `GateRequest` from that input and then
 * projects the rich `GateVerdict` back down to the narrow
 * `ImporterGateVerdict` the promotion rule consumes.
 *
 * Axiom anchor: A1 Epistemic Separation is preserved — the gate itself still
 * runs the oracles; the adapter is pure field-mapping. A3 Deterministic
 * Governance is preserved — no LLM in the adapter path.
 *
 * Decision mapping (real → importer):
 *
 *   GateVerdict.decision          → ImporterGateVerdict.decision
 *     'allow'                     → 'allow'
 *     'block'                     → 'block'
 *
 *   GateVerdict.epistemicDecision → ImporterGateVerdict.epistemicDecision
 *     'allow'                     → 'allow'
 *     'allow-with-caveats'        → 'allow-with-caveats'
 *     'uncertain'                 → 'uncertain'
 *     'block'                     → 'block'
 *     undefined                   → omitted
 *
 *   GateVerdict.aggregateConfidence → ImporterGateVerdict.aggregateConfidence
 *     number                        → number (pass-through)
 *     undefined                     → mean of `oracle_results[*].confidence`
 *                                     (only scored verdicts, skips abstentions);
 *                                     empty-set → 0
 *
 *   GateVerdict.reasons           → ImporterGateVerdict.reasons
 *     pass-through (oracle + guardrail reason strings).
 *
 * NB: the importer's promotion rule consumes `decision` and
 * `epistemicDecision` via `mapGateEpistemic()` in `importer.ts`. Preserving
 * both fields (rather than collapsing) keeps that mapping intact.
 *
 * Error handling: the adapter does NOT catch gate exceptions. The importer
 * treats any throw from its `gate` dep as a non-recoverable failure path;
 * rethrowing lets the importer's state machine record the failure and
 * produce a well-formed rejected state.
 */
import type { GateRequest, GateVerdict } from '../../gate/gate.ts';
import type { ImporterGateFn, ImporterGateRequest, ImporterGateVerdict } from './importer.ts';

/**
 * Structural type for the real `runGate` — accepts the full import or any
 * substitute that matches the same contract (tests use a stub).
 */
export type RunGateFn = (request: GateRequest) => Promise<GateVerdict>;

export interface GateAdapterDeps {
  readonly runGate: RunGateFn;
  /**
   * Workspace root passed through to every gate call. The importer also
   * threads its own `workspace` into the request; when they match, the
   * adapter prefers the importer's value so the dry-run evaluates against
   * the importer's quarantine tree.
   */
  readonly workspace: string;
}

/**
 * Build a `ImporterGateFn` that delegates to the real `runGate`.
 */
export function buildImporterGateFn(deps: GateAdapterDeps): ImporterGateFn {
  return async (req: ImporterGateRequest): Promise<ImporterGateVerdict> => {
    const request: GateRequest = {
      // The gate classifies tools as mutating / read-only via
      // `isMutatingTool`. Use a sentinel tool name that the gate treats as
      // mutating so the oracle suite actually runs. `write_file` is the
      // canonical mutating tool in this codebase.
      tool: 'write_file',
      params: {
        file_path: req.params.file_path,
        content: req.params.content,
        workspace: req.params.workspace || deps.workspace,
      },
      session_id: `skill-import/${req.skillId}`,
    };

    const verdict = await deps.runGate(request);
    return mapVerdict(verdict);
  };
}

/** Map the rich `GateVerdict` to the narrow shape the importer consumes. */
function mapVerdict(verdict: GateVerdict): ImporterGateVerdict {
  const aggregate = verdict.aggregateConfidence ?? fallbackAggregate(verdict);
  const result: ImporterGateVerdict = {
    decision: verdict.decision,
    aggregateConfidence: aggregate,
    reasons: verdict.reasons,
    ...(verdict.epistemicDecision ? { epistemicDecision: verdict.epistemicDecision } : {}),
  };
  return result;
}

/**
 * Fallback confidence when the real gate omits `aggregateConfidence` (e.g.
 * short-circuited on guardrail failure — no oracles ran). Computes the
 * arithmetic mean of scored oracle confidences; abstentions are excluded
 * (they carry no confidence). Empty set → 0.
 */
function fallbackAggregate(verdict: GateVerdict): number {
  const scored = Object.values(verdict.oracle_results ?? {});
  if (scored.length === 0) return 0;
  const sum = scored.reduce((acc, v) => acc + (v.confidence ?? 0), 0);
  return sum / scored.length;
}
