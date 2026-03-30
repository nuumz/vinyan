/**
 * Working Memory — per-task in-memory store for failed approaches,
 * hypotheses, uncertainties, and scoped facts.
 *
 * Source of truth: vinyan-tdd.md §16.2 (Learn step)
 */
import type { WorkingMemoryState } from "./types.ts";

export class WorkingMemory {
  private failedApproaches: WorkingMemoryState["failedApproaches"] = [];
  private activeHypotheses: WorkingMemoryState["activeHypotheses"] = [];
  private unresolvedUncertainties: WorkingMemoryState["unresolvedUncertainties"] = [];
  private scopedFacts: WorkingMemoryState["scopedFacts"] = [];

  recordFailedApproach(approach: string, oracleVerdict: string): void {
    this.failedApproaches.push({ approach, oracleVerdict, timestamp: Date.now() });
  }

  addHypothesis(hypothesis: string, confidence: number, source: string): void {
    this.activeHypotheses.push({ hypothesis, confidence, source });
  }

  addUncertainty(area: string, selfModelConfidence: number, suggestedAction: string): void {
    this.unresolvedUncertainties.push({ area, selfModelConfidence, suggestedAction });
  }

  addScopedFact(target: string, pattern: string, verified: boolean, hash: string): void {
    this.scopedFacts.push({ target, pattern, verified, hash });
  }

  /** Returns a deep copy — safe for serialization across process boundaries. */
  getSnapshot(): WorkingMemoryState {
    return JSON.parse(JSON.stringify({
      failedApproaches: this.failedApproaches,
      activeHypotheses: this.activeHypotheses,
      unresolvedUncertainties: this.unresolvedUncertainties,
      scopedFacts: this.scopedFacts,
    }));
  }
}
