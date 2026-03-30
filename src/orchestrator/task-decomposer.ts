/**
 * Task Decomposer — LLM-assisted decomposition with DAG validation.
 *
 * 3-iteration retry loop: generate DAG → validate → feedback → retry.
 * Falls back to single-node DAG (stub behavior) after max retries.
 *
 * Source of truth: vinyan-tdd.md §10, arch D7
 */
import type { TaskDecomposer } from "./core-loop.ts";
import type { TaskInput, PerceptualHierarchy, WorkingMemoryState, TaskDAG } from "./types.ts";
import type { LLMProviderRegistry } from "./llm/provider-registry.ts";
import { validateDAG, allCriteriaMet, formatFailures } from "./dag-validator.ts";

const MAX_RETRIES = 3;

export class TaskDecomposerImpl implements TaskDecomposer {
  private registry: LLMProviderRegistry;
  private maxRetries: number;

  constructor(options: { registry: LLMProviderRegistry; maxRetries?: number }) {
    this.registry = options.registry;
    this.maxRetries = options.maxRetries ?? MAX_RETRIES;
  }

  async decompose(
    input: TaskInput,
    perception: PerceptualHierarchy,
    memory: WorkingMemoryState,
  ): Promise<TaskDAG> {
    const provider = this.registry.selectByTier("balanced");
    if (!provider) return this.fallbackDAG(input);

    const blastRadius = [
      ...(input.targetFiles ?? []),
      ...perception.dependencyCone.directImportees,
    ];

    let validationFeedback: string | undefined;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const { systemPrompt, userPrompt } = this.buildPrompt(
          input, perception, memory, validationFeedback,
        );

        const response = await provider.generate({
          systemPrompt,
          userPrompt,
          maxTokens: 4000,
        });

        const dag = this.parseDAG(response.content);
        if (!dag) {
          validationFeedback = "Response was not valid JSON matching TaskDAG schema. Return a JSON object with a 'nodes' array.";
          continue;
        }

        const criteria = validateDAG(dag, blastRadius);
        if (allCriteriaMet(criteria)) {
          return dag;
        }

        validationFeedback = formatFailures(criteria).join("\n");
      } catch {
        validationFeedback = "LLM call failed. Please produce valid JSON.";
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

Target files: ${(input.targetFiles ?? []).join(", ") || "not specified"}
Direct importees: ${perception.dependencyCone.directImportees.join(", ") || "none"}
Blast radius: ${perception.dependencyCone.transitiveBlastRadius} files`;

    if (memory.failedApproaches.length > 0) {
      userPrompt += `\n\nPreviously failed approaches (avoid these):\n${memory.failedApproaches.map(a => `- ${a.approach}: ${a.oracleVerdict}`).join("\n")}`;
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
          typeof node.id !== "string" ||
          typeof node.description !== "string" ||
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
      nodes: [{
        id: "n1",
        description: input.goal,
        targetFiles: input.targetFiles ?? [],
        dependencies: [],
        assignedOracles: ["type", "dep"],
      }],
    };
  }
}

function stripCodeBlock(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  return match ? match[1]! : trimmed;
}
