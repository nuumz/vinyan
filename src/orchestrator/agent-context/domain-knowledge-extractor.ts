/**
 * Domain Knowledge Extractor — deterministic extraction of file-specific expertise.
 *
 * Analyzes an agent's execution traces to identify files/modules where the agent
 * consistently succeeds. Cross-references oracle verdicts to build grounded knowledge.
 *
 * Pure function — no LLM calls, no side effects (A3 compliant).
 *
 * Source of truth: Living Agent Soul plan, Phase 3
 */
import type { DomainEntry } from './soul-schema.ts';
import { SOUL_SECTION_LIMITS } from './soul-schema.ts';

/** Minimal trace projection for domain extraction. */
export interface TraceForDomain {
  outcome: 'success' | 'failure' | 'timeout' | 'escalated';
  affectedFiles: string[];
  oracleVerdicts: Record<string, boolean>;
  timestamp: number;
}

/** Extract domain expertise from agent traces. */
export function extractDomainKnowledge(traces: TraceForDomain[]): DomainEntry[] {
  if (traces.length < 3) return []; // Need minimum data

  // Group by file directory (module level)
  const moduleStats = new Map<string, { successes: number; total: number; files: Set<string>; oracles: Map<string, number>; lastTimestamp: number }>();

  for (const trace of traces) {
    for (const file of trace.affectedFiles) {
      const module = extractModule(file);
      const stats = moduleStats.get(module) ?? { successes: 0, total: 0, files: new Set<string>(), oracles: new Map<string, number>(), lastTimestamp: 0 };

      stats.total++;
      if (trace.outcome === 'success') stats.successes++;
      stats.files.add(file);
      stats.lastTimestamp = Math.max(stats.lastTimestamp, trace.timestamp);

      // Track which oracles this agent passes consistently
      for (const [oracle, passed] of Object.entries(trace.oracleVerdicts)) {
        if (passed) stats.oracles.set(oracle, (stats.oracles.get(oracle) ?? 0) + 1);
      }

      moduleStats.set(module, stats);
    }
  }

  // Convert to domain entries — only modules with sufficient evidence + high success rate
  const entries: DomainEntry[] = [];

  for (const [module, stats] of moduleStats) {
    if (stats.total < 3) continue; // Minimum observations
    const successRate = stats.successes / stats.total;
    if (successRate < 0.7) continue; // Must be genuinely good

    // Build knowledge from oracle mastery
    const topOracles = [...stats.oracles.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name]) => name);

    const knowledge = topOracles.length > 0
      ? `${stats.successes}/${stats.total} success rate, mastered oracles: ${topOracles.join(', ')}`
      : `${stats.successes}/${stats.total} success rate`;

    entries.push({
      area: module,
      files: [...stats.files].slice(0, 5),
      knowledge,
      lastEvidence: stats.lastTimestamp,
    });
  }

  // Sort by success count (most experienced first)
  return entries
    .sort((a, b) => {
      const aStats = moduleStats.get(a.area)!;
      const bStats = moduleStats.get(b.area)!;
      return bStats.successes - aStats.successes;
    })
    .slice(0, SOUL_SECTION_LIMITS.domainExpertise);
}

/** Extract module path from file path (directory level). */
function extractModule(filePath: string): string {
  const parts = filePath.split('/');
  // Keep up to 2 directory levels for meaningful grouping
  if (parts.length <= 2) return filePath;
  return parts.slice(0, -1).join('/');
}
