/**
 * Prompt Assembler — builds system and user prompts for LLM workers.
 *
 * System: ROLE + OUTPUT FORMAT
 * User: PERCEPTION + CONSTRAINTS + GOAL + PLAN
 *
 * Source of truth: vinyan-tdd.md §17.2
 */
import type { PerceptualHierarchy, WorkingMemoryState, TaskDAG } from "../types.ts";

export interface AssembledPrompt {
  systemPrompt: string;
  userPrompt: string;
}

export function assemblePrompt(
  goal: string,
  perception: PerceptualHierarchy,
  memory: WorkingMemoryState,
  plan?: TaskDAG,
): AssembledPrompt {
  const systemPrompt = buildSystemPrompt(perception);
  const userPrompt = buildUserPrompt(goal, perception, memory, plan);
  return { systemPrompt, userPrompt };
}

function buildSystemPrompt(perception: PerceptualHierarchy): string {
  const tools = perception.runtime.availableTools.join(", ");
  return `[ROLE]
You are a coding worker in the Vinyan Epistemic Nervous System.
You generate code proposals that will be verified by external oracles.
Do NOT self-evaluate your output — external verification determines correctness.

[OUTPUT FORMAT]
Respond with a JSON object matching this structure:
{
  "proposedMutations": [{ "file": "path", "content": "full file content", "explanation": "why" }],
  "proposedToolCalls": [{ "id": "tc-1", "tool": "tool_name", "parameters": {} }],
  "uncertainties": ["areas of uncertainty"]
}

[AVAILABLE TOOLS]
${tools}

Do NOT execute tool calls yourself — propose them and the Orchestrator will execute.`;
}

function buildUserPrompt(
  goal: string,
  perception: PerceptualHierarchy,
  memory: WorkingMemoryState,
  plan?: TaskDAG,
): string {
  const sections: string[] = [];

  // GOAL
  sections.push(`[TASK]\n${goal}`);

  // PERCEPTION
  sections.push(`[PERCEPTION]
Target: ${perception.taskTarget.file} — ${perception.taskTarget.description}
Direct importers: ${perception.dependencyCone.directImporters.join(", ") || "none"}
Direct importees: ${perception.dependencyCone.directImportees.join(", ") || "none"}
Blast radius: ${perception.dependencyCone.transitiveBlastRadius} files`);

  if (perception.diagnostics.typeErrors.length > 0) {
    const errors = perception.diagnostics.typeErrors
      .slice(0, 10)
      .map(e => `  ${e.file}:${e.line}: ${e.message}`)
      .join("\n");
    sections.push(`[DIAGNOSTICS]\n${errors}`);
  }

  if (perception.verifiedFacts.length > 0) {
    const facts = perception.verifiedFacts
      .slice(0, 10)
      .map(f => `  ${f.target}: ${f.pattern} (verified)`)
      .join("\n");
    sections.push(`[VERIFIED FACTS]\n${facts}`);
  }

  // CONSTRAINTS (failed approaches)
  if (memory.failedApproaches.length > 0) {
    const constraints = memory.failedApproaches
      .map(f => `  - Do NOT try: ${f.approach} (rejected: ${f.oracleVerdict})`)
      .join("\n");
    sections.push(`[CONSTRAINTS]\n${constraints}`);
  }

  // HYPOTHESES
  if (memory.activeHypotheses.length > 0) {
    const hypotheses = memory.activeHypotheses
      .map(h => `  - ${h.hypothesis} (confidence: ${h.confidence}, source: ${h.source})`)
      .join("\n");
    sections.push(`[HYPOTHESES]\n${hypotheses}`);
  }

  // UNCERTAINTIES
  if (memory.unresolvedUncertainties.length > 0) {
    const uncertainties = memory.unresolvedUncertainties
      .map(u => `  - ${u.area}: ${u.suggestedAction}`)
      .join("\n");
    sections.push(`[UNCERTAINTIES]\n${uncertainties}`);
  }

  // PLAN (L2+ only)
  if (plan && plan.nodes.length > 0) {
    const steps = plan.nodes
      .map((n, i) => `  ${i + 1}. ${n.description} → ${n.targetFiles.join(", ")}`)
      .join("\n");
    sections.push(`[PLAN]\n${steps}`);
  }

  return sections.join("\n\n");
}
