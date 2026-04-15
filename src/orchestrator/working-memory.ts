/**
 * Working Memory — per-task in-memory store for failed approaches,
 * hypotheses, uncertainties, and scoped facts.
 *
 * All arrays are bounded with eviction policies to prevent
 * prompt bloat during long retry loops.
 *
 * Source of truth: spec/tdd.md §16.2 (Learn step)
 */

import type { VinyanBus } from '../core/bus.ts';
import { sanitizeForPrompt } from '../guardrails/index.ts';
import type { AgentSessionSummary, WorkingMemoryState } from './types.ts';

export const MAX_FAILED_APPROACHES = 20;
export const MAX_HYPOTHESES = 10;
export const MAX_UNCERTAINTIES = 10;
export const MAX_SCOPED_FACTS = 50;

/** Threshold at which memory pressure is considered high enough to warn. */
const EVICTION_WARNING_THRESHOLD = 10;

/** Callback to archive evicted/completed failed approaches to persistent storage. */
export type FailedApproachArchiver = (entry: WorkingMemoryState['failedApproaches'][number]) => void;

export class WorkingMemory {
  private failedApproaches: WorkingMemoryState['failedApproaches'] = [];
  private activeHypotheses: WorkingMemoryState['activeHypotheses'] = [];
  private unresolvedUncertainties: WorkingMemoryState['unresolvedUncertainties'] = [];
  private scopedFacts: WorkingMemoryState['scopedFacts'] = [];
  private priorAttempts: AgentSessionSummary[] = [];
  private bus?: VinyanBus;
  private taskId?: string;
  private archiver?: FailedApproachArchiver;

  constructor(options?: { bus?: VinyanBus; taskId?: string; archiver?: FailedApproachArchiver }) {
    this.bus = options?.bus;
    this.taskId = options?.taskId;
    this.archiver = options?.archiver;
  }

  recordFailedApproach(approach: string, oracleVerdict: string, verdictConfidence?: number, failureOracle?: string, classifiedFailures?: Array<{ category: string; file?: string; line?: number; message: string; severity: 'error' | 'warning'; suggestedFix?: string }>): void {
    if (this.failedApproaches.length >= MAX_FAILED_APPROACHES) {
      // EO #8: Evict lowest-confidence approach (least informative) instead of FIFO
      // NOTE: undefined confidence → 0.5 (unknown ≠ low; treat as neutral)
      let minIdx = 0;
      for (let i = 1; i < this.failedApproaches.length; i++) {
        const conf = this.failedApproaches[i]!.verdictConfidence ?? 0.5;
        if (conf < (this.failedApproaches[minIdx]!.verdictConfidence ?? 0.5)) {
          minIdx = i;
        }
      }
      // G2: Archive evicted entry before removal — preserves forensic trail
      const evicted = this.failedApproaches[minIdx]!;
      try {
        this.archiver?.(evicted);
      } catch {
        // Archival is best-effort — eviction proceeds regardless
      }
      this.failedApproaches.splice(minIdx, 1);
    }
    // Storage-layer sanitization: sanitize LLM-generated text at write time (not just at prompt assembly)
    this.failedApproaches.push({
      approach: sanitizeForPrompt(approach).cleaned,
      oracleVerdict: sanitizeForPrompt(oracleVerdict).cleaned,
      timestamp: Date.now(),
      verdictConfidence,
      failureOracle,
      classifiedFailures,
    });

    // G3: Emit memory pressure warning for GAP-H FC4 detection
    if (this.bus && this.taskId && this.failedApproaches.length >= EVICTION_WARNING_THRESHOLD) {
      this.bus.emit('memory:eviction_warning', {
        taskId: this.taskId,
        evictionCount: this.failedApproaches.length,
        memoryPressure: this.failedApproaches.length / MAX_FAILED_APPROACHES,
      });
    }
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

  /** Add retry context from a prior agentic session (Phase 6.3). */
  addPriorAttempt(summary: AgentSessionSummary): void {
    this.priorAttempts.push(summary);
  }

  /** Wave 1: attach an archiver if not already set. Used by goal-loop hand-off where
   *  WorkingMemory is created outside prepareExecution but still needs archiving. */
  attachArchiver(archiver: FailedApproachArchiver): void {
    if (!this.archiver) this.archiver = archiver;
  }

  /** G2: Archive all remaining failed approaches to persistent storage at task end.
   *  Called before WorkingMemory instance is discarded. */
  archiveRemainingApproaches(): void {
    if (!this.archiver) return;
    for (const entry of this.failedApproaches) {
      try {
        this.archiver(entry);
      } catch {
        // Best-effort — continue archiving remaining entries
      }
    }
  }

  /** Returns a deep copy — safe for serialization across process boundaries. */
  getSnapshot(): WorkingMemoryState {
    return JSON.parse(
      JSON.stringify({
        failedApproaches: this.failedApproaches,
        activeHypotheses: this.activeHypotheses,
        unresolvedUncertainties: this.unresolvedUncertainties,
        scopedFacts: this.scopedFacts,
        ...(this.priorAttempts.length > 0 ? { priorAttempts: this.priorAttempts } : {}),
      }),
    );
  }
}
