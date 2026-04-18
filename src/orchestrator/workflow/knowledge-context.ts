/**
 * Knowledge Context Builder — assembles a structured context block for
 * the Workflow Planner by querying the "second brain": World Graph
 * (verified facts), Skill Store (proven approaches), Rejected Approach
 * Store (approaches to avoid), and Sleep Cycle patterns.
 *
 * A1: read-only — never mutates any store.
 * A3: assembly is deterministic string concatenation.
 */
import type { WorldGraph } from '../../world-graph/world-graph.ts';
import type { AgentMemoryAPI } from '../agent-memory/agent-memory-api.ts';

export interface KnowledgeContextDeps {
  agentMemory?: AgentMemoryAPI;
  worldGraph?: WorldGraph;
}

export interface KnowledgeContextOptions {
  targetFiles?: string[];
  taskSignature?: string;
  maxFactsPerFile?: number;
  maxSkills?: number;
  maxRejectedApproaches?: number;
}

const DEFAULTS: Required<Omit<KnowledgeContextOptions, 'targetFiles' | 'taskSignature'>> = {
  maxFactsPerFile: 5,
  maxSkills: 3,
  maxRejectedApproaches: 5,
};

export async function buildKnowledgeContext(
  deps: KnowledgeContextDeps,
  opts: KnowledgeContextOptions = {},
): Promise<string> {
  const sections: string[] = [];
  const maxFacts = opts.maxFactsPerFile ?? DEFAULTS.maxFactsPerFile;
  const maxSkills = opts.maxSkills ?? DEFAULTS.maxSkills;
  const maxRejected = opts.maxRejectedApproaches ?? DEFAULTS.maxRejectedApproaches;

  // ── Verified facts from World Graph ────────────────────────────────
  if (deps.worldGraph && opts.targetFiles?.length) {
    const factLines: string[] = [];
    for (const file of opts.targetFiles.slice(0, 10)) {
      try {
        const facts = deps.worldGraph.queryFacts(file).slice(0, maxFacts);
        for (const f of facts) {
          factLines.push(`  - [${f.target}] ${f.pattern} (confidence: ${(f.confidence ?? 0).toFixed(2)})`);
        }
      } catch {
        // best-effort
      }
    }
    if (factLines.length > 0) {
      sections.push(`[VERIFIED FACTS]\n${factLines.join('\n')}`);
    }
  }

  // ── Proven approaches from Agent Memory ────────────────────────────
  if (deps.agentMemory && opts.taskSignature) {
    try {
      const skills = await deps.agentMemory.queryRelatedSkills(opts.taskSignature, { k: maxSkills });
      if (skills.length > 0) {
        const skillLines = skills.map(
          (s, i) => `  ${i + 1}. ${s.approach} (success: ${Math.round((s.successRate ?? 0) * 100)}%, uses: ${s.usageCount ?? 0})`,
        );
        sections.push(`[PROVEN APPROACHES]\n${skillLines.join('\n')}`);
      }
    } catch {
      // best-effort
    }

    try {
      const rejected = await deps.agentMemory.queryFailedApproaches(opts.taskSignature, { limit: maxRejected });
      if (rejected.length > 0) {
        const rejLines = rejected.map(
          (r) => `  - AVOID: ${r.approach} (reason: ${r.oracle_verdict})`,
        );
        sections.push(`[APPROACHES TO AVOID]\n${rejLines.join('\n')}`);
      }
    } catch {
      // best-effort
    }
  }

  return sections.length > 0 ? sections.join('\n\n') : '';
}
