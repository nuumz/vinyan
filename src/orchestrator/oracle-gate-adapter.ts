/**
 * Oracle Gate Adapter — wraps Phase 0's runGate() for the OracleGate interface.
 *
 * Maps mutations[] → individual GateRequest calls → aggregated VerificationResult.
 * Source of truth: spec/tdd.md §16 (Core Loop Step 5: VERIFY)
 */
import type { OracleVerdict } from '../core/types.ts';
import type { EpistemicGateDecision } from '../gate/epistemic-decision.ts';
import type { GateRequest } from '../gate/gate.ts';
import { runGate } from '../gate/gate.ts';
import type { OracleGate } from './core-loop.ts';
import type { VerificationHint } from './types.ts';

export class OracleGateAdapter implements OracleGate {
  private workspace: string;

  constructor(workspace: string) {
    this.workspace = workspace;
  }

  async verify(
    mutations: Array<{ file: string; content: string }>,
    _workspace: string,
    verificationHint?: VerificationHint,
    routingLevel?: number,
    commonsenseSignals?: GateRequest['commonsenseSignals'],
  ) {
    // Empty mutations (L0) → trivially pass
    if (mutations.length === 0) {
      return { passed: true as const, verdicts: {} as Record<string, OracleVerdict> };
    }

    const allVerdicts: Record<string, OracleVerdict> = {};
    const reasons: string[] = [];
    let allPassed = true;

    // Track epistemic fields — use most conservative across all gate results
    let worstEpistemic: EpistemicGateDecision | undefined;
    let lowestConfidence: number | undefined;
    const allCaveats: string[] = [];

    // Epistemic decision severity for picking the worst
    const SEVERITY: Record<EpistemicGateDecision, number> = {
      allow: 0,
      'allow-with-caveats': 1,
      uncertain: 2,
      block: 3,
    };

    // Run gate verification in parallel for multi-file mutations
    const results = await Promise.all(
      mutations.map((mutation) =>
        runGate({
          tool: 'write_file',
          params: {
            file_path: mutation.file,
            content: mutation.content,
            workspace: this.workspace,
          },
          verificationHint,
          routingLevel,
          // M3.5 — feed self-model signals to commonsense oracle activation gate
          ...(commonsenseSignals ? { commonsenseSignals } : {}),
        }).then((gateResult) => ({ mutation, gateResult })),
      ),
    );

    for (const { mutation, gateResult } of results) {
      // Merge oracle results — keyed by oracle:file, fail wins over pass
      for (const [name, verdict] of Object.entries(gateResult.oracle_results)) {
        const key = `${name}:${mutation.file}`;
        const existing = allVerdicts[key];
        if (!existing || !verdict.verified) {
          allVerdicts[key] = verdict;
        }
      }

      if (gateResult.decision === 'block') {
        allPassed = false;
        reasons.push(...gateResult.reasons);
      }

      // Aggregate epistemic fields — keep the worst (most conservative)
      if (gateResult.epistemicDecision) {
        if (!worstEpistemic || SEVERITY[gateResult.epistemicDecision] > SEVERITY[worstEpistemic]) {
          worstEpistemic = gateResult.epistemicDecision;
        }
      }
      if (gateResult.aggregateConfidence !== undefined) {
        if (lowestConfidence === undefined || gateResult.aggregateConfidence < lowestConfidence) {
          lowestConfidence = gateResult.aggregateConfidence;
        }
      }
      if (gateResult.caveats) {
        allCaveats.push(...gateResult.caveats);
      }
    }

    return {
      passed: allPassed,
      verdicts: allVerdicts,
      reason: allPassed ? undefined : reasons.join('; '),
      epistemicDecision: worstEpistemic,
      aggregateConfidence: lowestConfidence,
      caveats: allCaveats.length > 0 ? allCaveats : undefined,
    };
  }
}
