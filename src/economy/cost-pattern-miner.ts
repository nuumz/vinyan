/**
 * Cost Pattern Miner — Sleep Cycle extension for cost anti-patterns and success-patterns.
 *
 * Detects:
 * - Anti-pattern: engine Y on task type X costs >2× median (Wilson LB ≥ 0.6)
 * - Success-pattern: engine A at <50% cost of B with comparable quality (Wilson LB ≥ 0.15)
 *
 * A3 compliant: deterministic pattern detection, no LLM.
 *
 * Source of truth: Economy OS plan §E2.4
 */
import { wilsonLowerBound } from '../sleep-cycle/wilson.ts';
import type { CostLedger, CostLedgerEntry } from './cost-ledger.ts';

export interface CostPattern {
  id: string;
  type: 'cost-anti-pattern' | 'cost-success-pattern';
  description: string;
  taskTypeSignature: string;
  engineId: string;
  comparedEngineId?: string;
  costRatio: number;
  confidence: number;
  observationCount: number;
  detectedAt: number;
}

/** Minimum observations per engine per task type before pattern detection. */
const MIN_OBSERVATIONS = 5;

/** Anti-pattern: engine costs >2× median. */
const ANTI_PATTERN_COST_RATIO = 2.0;
/** Anti-pattern Wilson LB threshold. */
const ANTI_PATTERN_CONFIDENCE = 0.6;

/** Success-pattern: engine at <50% cost of another. */
const SUCCESS_PATTERN_COST_RATIO = 0.5;
/** Success-pattern Wilson LB threshold. */
const SUCCESS_PATTERN_CONFIDENCE = 0.15;

export class CostPatternMiner {
  private ledger: CostLedger;

  constructor(ledger: CostLedger) {
    this.ledger = ledger;
  }

  /** Extract cost patterns from the ledger. */
  extract(): CostPattern[] {
    const patterns: CostPattern[] = [];
    const entries = this.ledger.queryByTimeRange(0, Date.now());

    // Group by task type signature
    const byTaskType = new Map<string, CostLedgerEntry[]>();
    for (const entry of entries) {
      if (!entry.task_type_signature) continue;
      const existing = byTaskType.get(entry.task_type_signature) ?? [];
      existing.push(entry);
      byTaskType.set(entry.task_type_signature, existing);
    }

    for (const [taskSig, taskEntries] of byTaskType) {
      // Group by engine within task type
      const byEngine = new Map<string, CostLedgerEntry[]>();
      for (const entry of taskEntries) {
        const existing = byEngine.get(entry.engineId) ?? [];
        existing.push(entry);
        byEngine.set(entry.engineId, existing);
      }

      // Need at least 2 engines with enough observations
      const eligibleEngines = Array.from(byEngine.entries()).filter(([, e]) => e.length >= MIN_OBSERVATIONS);
      if (eligibleEngines.length < 2) continue;

      // Compute median cost across all engines for this task type
      const allCosts = taskEntries.map((e) => e.computed_usd).sort((a, b) => a - b);
      const median = allCosts[Math.floor(allCosts.length / 2)] ?? 0;
      if (median <= 0) continue;

      // Anti-patterns: engine costs >2× median
      for (const [engineId, engineEntries] of eligibleEngines) {
        const avgCost = engineEntries.reduce((sum, e) => sum + e.computed_usd, 0) / engineEntries.length;
        const ratio = avgCost / median;

        if (ratio >= ANTI_PATTERN_COST_RATIO) {
          // Count "expensive" observations (above 2× median)
          const expensive = engineEntries.filter((e) => e.computed_usd > median * ANTI_PATTERN_COST_RATIO).length;
          const wlb = wilsonLowerBound(expensive, engineEntries.length);

          if (wlb >= ANTI_PATTERN_CONFIDENCE) {
            patterns.push({
              id: `cost-anti-${taskSig}-${engineId}-${Date.now()}`,
              type: 'cost-anti-pattern',
              description: `Engine ${engineId} costs ${ratio.toFixed(1)}× median on ${taskSig}`,
              taskTypeSignature: taskSig,
              engineId,
              costRatio: ratio,
              confidence: wlb,
              observationCount: engineEntries.length,
              detectedAt: Date.now(),
            });
          }
        }
      }

      // Success-patterns: pairwise engine cost comparison
      for (let i = 0; i < eligibleEngines.length; i++) {
        for (let j = i + 1; j < eligibleEngines.length; j++) {
          const [engineA, entriesA] = eligibleEngines[i]!;
          const [engineB, entriesB] = eligibleEngines[j]!;

          const avgA = entriesA.reduce((sum, e) => sum + e.computed_usd, 0) / entriesA.length;
          const avgB = entriesB.reduce((sum, e) => sum + e.computed_usd, 0) / entriesB.length;

          // Check if A is significantly cheaper than B (or vice versa)
          const [cheaperId, cheaperAvg, expensiveId, expensiveAvg, cheaperEntries] =
            avgA < avgB ? [engineA, avgA, engineB, avgB, entriesA] : [engineB, avgB, engineA, avgA, entriesB];

          const ratio = cheaperAvg / expensiveAvg;
          if (ratio >= SUCCESS_PATTERN_COST_RATIO) continue; // Not cheap enough

          // Wilson LB on "cheaper is actually cheaper" observations
          const cheaperWins = cheaperEntries.filter((e) => e.computed_usd < expensiveAvg * 0.75).length;
          const wlb = wilsonLowerBound(cheaperWins, cheaperEntries.length);

          if (wlb >= SUCCESS_PATTERN_CONFIDENCE) {
            patterns.push({
              id: `cost-success-${taskSig}-${cheaperId}-${Date.now()}`,
              type: 'cost-success-pattern',
              description: `Engine ${cheaperId} is ${((1 - ratio) * 100).toFixed(0)}% cheaper than ${expensiveId} on ${taskSig}`,
              taskTypeSignature: taskSig,
              engineId: cheaperId,
              comparedEngineId: expensiveId,
              costRatio: ratio,
              confidence: wlb,
              observationCount: cheaperEntries.length,
              detectedAt: Date.now(),
            });
          }
        }
      }
    }

    return patterns;
  }
}
