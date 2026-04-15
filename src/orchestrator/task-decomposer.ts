/**
 * Task Decomposer — LLM-assisted decomposition with DAG validation.
 *
 * 3-iteration retry loop: generate DAG → validate → feedback → retry.
 * Falls back to single-node DAG (single-task fallback) after max retries.
 *
 * Source of truth: spec/tdd.md §10, arch D7
 */

import type { SkillStore } from '../db/skill-store.ts';
import type { TaskDecomposer } from './core-loop.ts';
import { allCriteriaMet, formatFailures, validateDAG } from './dag-validator.ts';
import type { LLMProviderRegistry } from './llm/provider-registry.ts';
import {
  buildResearchSwarmDAG,
  matchDecomposerPreset,
  RESEARCH_SWARM_REPORT_CONTRACT,
} from './task-decomposer-presets.ts';
import type { PerceptualHierarchy, TaskDAG, TaskInput, WorkingMemoryState } from './types.ts';

const MAX_RETRIES = 3;

export class TaskDecomposerImpl implements TaskDecomposer {
  private registry: LLMProviderRegistry;
  private maxRetries: number;
  private skillStore?: SkillStore;

  constructor(options: { registry: LLMProviderRegistry; maxRetries?: number; skillStore?: SkillStore }) {
    this.registry = options.registry;
    this.maxRetries = options.maxRetries ?? MAX_RETRIES;
    this.skillStore = options.skillStore;
  }

  async decompose(input: TaskInput, perception: PerceptualHierarchy, memory: WorkingMemoryState): Promise<TaskDAG> {
    // PH5 D2: Check if a composed skill matches the task fingerprint
    if (this.skillStore) {
      const composed = this.skillStore.findComposedSkill(input.goal);
      if (composed?.composedOf?.length) {
        const subSkills = composed.composedOf.map((sig) => this.skillStore!.findBySignature(sig)).filter(Boolean);
        if (subSkills.length > 0) {
          return {
            nodes: subSkills.map((skill, i) => ({
              id: `s${i + 1}`,
              description: skill!.approach,
              targetFiles: input.targetFiles ?? [],
              dependencies: i > 0 ? [`s${i}`] : [],
              assignedOracles: ['type', 'dep'],
            })),
            isFromComposedSkill: true,
          };
        }
      }
    }

    // Book-integration Wave 1.2: deterministic presets (e.g. research-swarm)
    // short-circuit the LLM path when the goal matches a well-known shape.
    // A3-safe: preset selection is pure keyword matching, no LLM involved.
    // The preset still produces a DAG that goes through the normal validator
    // below, so a broken preset cannot ship an invalid decomposition.
    const preset = matchDecomposerPreset(input);
    if (preset?.kind === 'research-swarm') {
      // Inject the report contract as a task constraint so every spawned
      // explorer sees it in its TaskUnderstanding pipeline. The aggregator
      // also sees it, which is intentional — the same schema keeps the
      // fan-in deterministic.
      input.constraints = [...(input.constraints ?? []), RESEARCH_SWARM_REPORT_CONTRACT];
      const presetDag = buildResearchSwarmDAG(input, perception);
      const presetBlastRadius = [...(input.targetFiles ?? []), ...perception.dependencyCone.directImportees];
      const criteria = validateDAG(presetDag, presetBlastRadius);
      if (allCriteriaMet(criteria)) {
        return presetDag;
      }
      // If the preset somehow produced an invalid DAG (e.g. blast radius
      // disagreement), log and fall through to the LLM path rather than
      // shipping a broken preset. The fall-through path is the same one
      // used when the LLM decomposer fails its retries.
    }

    const provider = this.registry.selectByTier('balanced');
    if (!provider) return this.fallbackDAG(input);

    const blastRadius = [...(input.targetFiles ?? []), ...perception.dependencyCone.directImportees];

    let validationFeedback: string | undefined;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const { systemPrompt, userPrompt } = this.buildPrompt(input, perception, memory, validationFeedback);

        const response = await provider.generate({
          systemPrompt,
          userPrompt,
          maxTokens: 4000,
        });

        const dag = this.parseDAG(response.content);
        if (!dag) {
          validationFeedback =
            "Response was not valid JSON matching TaskDAG schema. Return a JSON object with a 'nodes' array.";
          continue;
        }

        const criteria = validateDAG(dag, blastRadius);
        if (allCriteriaMet(criteria)) {
          return dag;
        }

        validationFeedback = formatFailures(criteria).join('\n');
      } catch {
        validationFeedback = 'LLM call failed. Please produce valid JSON.';
      }
    }

    // All retries exhausted → fallback
    return this.fallbackDAG(input);
  }

  private buildPrompt(
    input: TaskInput,
    perception: PerceptualHierarchy,
    memory: WorkingMemoryState,
    validationFeedback?: string,
  ): { systemPrompt: string; userPrompt: string } {
    const systemPrompt = `You are a task decomposer. Break the given coding goal into a DAG of subtasks.

Output ONLY valid JSON matching this schema:
{
  "nodes": [
    {
      "id": "string",
      "description": "string",
      "targetFiles": ["string"],
      "dependencies": ["string (IDs of prerequisite nodes)"],
      "assignedOracles": ["string (oracle names: ast, type, dep, test, lint)"]
    }
  ]
}

Rules:
- Each node targets specific files (no overlap between nodes)
- Dependencies form a DAG (no cycles)
- Every leaf node must have at least one assigned oracle
- Cover all files in the blast radius
- Use IDs like "n1", "n2", etc.`;

    let userPrompt = `Goal: ${input.goal}

Target files: ${(input.targetFiles ?? []).join(', ') || 'not specified'}
Direct importees: ${perception.dependencyCone.directImportees.join(', ') || 'none'}
Blast radius: ${perception.dependencyCone.transitiveBlastRadius} files`;

    // Gap 1A: Surface user constraints in decomposition (not just generation)
    if (input.constraints?.length) {
      userPrompt += `\n\nConstraints:\n${input.constraints.map((c) => `- ${c}`).join('\n')}`;
    }

    // Gap 1B: Surface acceptance criteria in decomposition
    if (input.acceptanceCriteria?.length) {
      userPrompt += `\n\nAcceptance criteria:\n${input.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}`;
    }

    if (memory.failedApproaches.length > 0) {
      userPrompt += `\n\nPreviously failed approaches (avoid these):\n${memory.failedApproaches.map((a) => `- ${a.approach}: ${a.oracleVerdict}`).join('\n')}`;
    }

    if (validationFeedback) {
      userPrompt += `\n\n⚠️ Your previous decomposition failed validation:\n${validationFeedback}\n\nPlease fix these issues.`;
    }

    return { systemPrompt, userPrompt };
  }

  private parseDAG(content: string): TaskDAG | null {
    try {
      const cleaned = stripCodeBlock(content);
      const parsed = JSON.parse(cleaned);
      if (!parsed.nodes || !Array.isArray(parsed.nodes)) return null;
      for (const node of parsed.nodes) {
        if (
          typeof node.id !== 'string' ||
          typeof node.description !== 'string' ||
          !Array.isArray(node.targetFiles) ||
          !Array.isArray(node.dependencies) ||
          !Array.isArray(node.assignedOracles)
        ) {
          return null;
        }
      }
      return parsed as TaskDAG;
    } catch {
      return null;
    }
  }

  private fallbackDAG(input: TaskInput): TaskDAG {
    return {
      nodes: [
        {
          id: 'n1',
          description: input.goal,
          targetFiles: input.targetFiles ?? [],
          dependencies: [],
          assignedOracles: ['type', 'dep'],
        },
      ],
      isFallback: true,
    };
  }
}

function stripCodeBlock(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  return match ? match[1]! : trimmed;
}

/**
 * Task Decomposer Stub — returns single-node DAG wrapping the input goal.
 *
 * Production fallback when no LLM provider is configured (air-gapped, local dev).
 * See TaskDecomposerImpl above for the full LLM-assisted implementation.
 */
export class TaskDecomposerStub implements TaskDecomposer {
  async decompose(input: TaskInput, _perception: PerceptualHierarchy, _memory: WorkingMemoryState): Promise<TaskDAG> {
    return {
      nodes: [
        {
          id: 'n1',
          description: input.goal,
          targetFiles: input.targetFiles ?? [],
          dependencies: [],
          assignedOracles: ['type', 'dep'],
        },
      ],
    };
  }
}
