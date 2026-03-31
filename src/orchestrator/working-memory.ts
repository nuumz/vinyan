/**
 * Working Memory — per-task in-memory store for failed approaches,
 * hypotheses, uncertainties, and scoped facts.
 *
 * All arrays are bounded with eviction policies to prevent
 * prompt bloat during long retry loops.
 *
 * Source of truth: vinyan-tdd.md §16.2 (Learn step)
 */
import type { WorkingMemoryState } from "./types.ts";

export const MAX_FAILED_APPROACHES = 20;
export const MAX_HYPOTHESES = 10;
export const MAX_UNCERTAINTIES = 10;
export const MAX_SCOPED_FACTS = 50;

export class WorkingMemory {
  private failedApproaches: WorkingMemoryState["failedApproaches"] = [];
  private activeHypotheses: WorkingMemoryState["activeHypotheses"] = [];
  private unresolvedUncertainties: WorkingMemoryState["unresolvedUncertainties"] = [];
  private scopedFacts: WorkingMemoryState["scopedFacts"] = [];

  recordFailedApproach(approach: string, oracleVerdict: string): void {
    if (this.failedApproaches.length >= MAX_FAILED_APPROACHES) {
      this.failedApproaches.shift(); // evict oldest
    }
    this.failedApproaches.push({ approach, oracleVerdict, timestamp: Date.now() });
  }

  addHypothesis(hypothesis: string, confidence: number, source: string): void {
    if (this.activeHypotheses.length >= MAX_HYPOTHESES) {
      // Evict lowest-confidence hypothesis
      let minIdx = 0;
      for (let i = 1; i < this.activeHypotheses.length; i++) {
        if (this.activeHypotheses[i]!.confidence < this.activeHypotheses[minIdx]!.confidence) {
          minIdx = i;
        }
      }
      this.activeHypotheses.splice(minIdx, 1);
    }
    this.activeHypotheses.push({ hypothesis, confidence, source });
  }

  addUncertainty(area: string, selfModelConfidence: number, suggestedAction: string): void {
    if (this.unresolvedUncertainties.length >= MAX_UNCERTAINTIES) {
      this.unresolvedUncertainties.shift(); // evict oldest
    }
    this.unresolvedUncertainties.push({ area, selfModelConfidence, suggestedAction });
  }

  addScopedFact(target: string, pattern: string, verified: boolean, hash: string): void {
    if (this.scopedFacts.length >= MAX_SCOPED_FACTS) {
      this.scopedFacts.shift(); // evict oldest
    }
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
