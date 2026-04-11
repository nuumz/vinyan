/**
 * Cost Signaling — computational cost tracking for A2A interactions.
 *
 * Attached to task_result and oracle_verdict ECP data parts (cost field).
 * Pure aggregation layer — no bus events, no trust impact.
 * Schema: CostSignalSchema in ecp-data-part.ts (lines 34-41).
 *
 * Source of truth: Plan Phase K1
 */

export interface CostRecord {
  peerId: string;
  taskId: string;
  cost: {
    tokens_input: number;
    tokens_output: number;
    duration_ms: number;
    oracle_invocations: number;
    estimated_usd?: number;
    budget_utilization_pct?: number;
  };
  timestamp: number;
}

export class CostTracker {
  private records: CostRecord[] = [];

  record(peerId: string, taskId: string, cost: CostRecord['cost']): void {
    this.records.push({ peerId, taskId, cost, timestamp: Date.now() });
  }

  getAverageCost(): { tokens_input: number; tokens_output: number; duration_ms: number; oracle_invocations: number } {
    if (this.records.length === 0) {
      return { tokens_input: 0, tokens_output: 0, duration_ms: 0, oracle_invocations: 0 };
    }

    const sum = this.records.reduce(
      (acc, r) => ({
        tokens_input: acc.tokens_input + r.cost.tokens_input,
        tokens_output: acc.tokens_output + r.cost.tokens_output,
        duration_ms: acc.duration_ms + r.cost.duration_ms,
        oracle_invocations: acc.oracle_invocations + r.cost.oracle_invocations,
      }),
      { tokens_input: 0, tokens_output: 0, duration_ms: 0, oracle_invocations: 0 },
    );

    const n = this.records.length;
    return {
      tokens_input: sum.tokens_input / n,
      tokens_output: sum.tokens_output / n,
      duration_ms: sum.duration_ms / n,
      oracle_invocations: sum.oracle_invocations / n,
    };
  }

  getTotalCost(): {
    tokens_input: number;
    tokens_output: number;
    duration_ms: number;
    oracle_invocations: number;
    estimated_usd: number;
  } {
    return this.records.reduce(
      (acc, r) => ({
        tokens_input: acc.tokens_input + r.cost.tokens_input,
        tokens_output: acc.tokens_output + r.cost.tokens_output,
        duration_ms: acc.duration_ms + r.cost.duration_ms,
        oracle_invocations: acc.oracle_invocations + r.cost.oracle_invocations,
        estimated_usd: acc.estimated_usd + (r.cost.estimated_usd ?? 0),
      }),
      { tokens_input: 0, tokens_output: 0, duration_ms: 0, oracle_invocations: 0, estimated_usd: 0 },
    );
  }

  getCostByPeer(peerId: string): CostRecord[] {
    return this.records.filter((r) => r.peerId === peerId);
  }

  getRecordCount(): number {
    return this.records.length;
  }
}
