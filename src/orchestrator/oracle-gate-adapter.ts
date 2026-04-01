/**
 * Oracle Gate Adapter — wraps Phase 0's runGate() for the OracleGate interface.
 *
 * Maps mutations[] → individual GateRequest calls → aggregated VerificationResult.
 * Source of truth: spec/tdd.md §16 (Core Loop Step 5: VERIFY)
 */
import { runGate } from "../gate/gate.ts";
import type { OracleVerdict } from "../core/types.ts";
import type { OracleGate } from "./core-loop.ts";

export class OracleGateAdapter implements OracleGate {
  private workspace: string;

  constructor(workspace: string) {
    this.workspace = workspace;
  }

  async verify(
    mutations: Array<{ file: string; content: string }>,
    _workspace: string,
  ) {
    // Empty mutations (L0) → trivially pass
    if (mutations.length === 0) {
      return { passed: true as const, verdicts: {} as Record<string, OracleVerdict> };
    }

    const allVerdicts: Record<string, OracleVerdict> = {};
    const reasons: string[] = [];
    let allPassed = true;

    // Run gate verification in parallel for multi-file mutations
    const results = await Promise.all(
      mutations.map(mutation =>
        runGate({
          tool: "write_file",
          params: {
            file_path: mutation.file,
            content: mutation.content,
            workspace: this.workspace,
          },
        }).then(gateResult => ({ mutation, gateResult })),
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

      if (gateResult.decision === "block") {
        allPassed = false;
        reasons.push(...gateResult.reasons);
      }
    }

    return {
      passed: allPassed,
      verdicts: allVerdicts,
      reason: allPassed ? undefined : reasons.join("; "),
    };
  }
}
