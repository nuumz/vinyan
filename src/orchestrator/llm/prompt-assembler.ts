/**
 * Prompt Assembler — builds system and user prompts for LLM workers.
 *
 * System: ROLE + OUTPUT FORMAT
 * User: PERCEPTION + CONSTRAINTS + GOAL + PLAN
 *
 * All untrusted text (goal, diagnostics, working memory, facts)
 * is sanitized through guardrail scanners before interpolation.
 *
 * Source of truth: spec/tdd.md §17.2
 */

import { sanitizeForPrompt } from '../../guardrails/index.ts';
import type { PerceptualHierarchy, TaskDAG, WorkingMemoryState } from '../types.ts';

/** Sanitize a string for safe prompt inclusion. */
function clean(s: string): string {
  return sanitizeForPrompt(s).cleaned;
}

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
  const tools = perception.runtime.availableTools.join(', ');
  return `[ROLE]
You are a coding worker in Vinyan, an autonomous orchestrator powered by Epistemic Orchestration.
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

  // GOAL — sanitized (user/API input)
  sections.push(`[TASK]\n${clean(goal)}`);

  // PERCEPTION
  sections.push(`[PERCEPTION]
Target: ${perception.taskTarget.file} — ${clean(perception.taskTarget.description)}
Direct importers: ${perception.dependencyCone.directImporters.join(', ') || 'none'}
Direct importees: ${perception.dependencyCone.directImportees.join(', ') || 'none'}
Blast radius: ${perception.dependencyCone.transitiveBlastRadius} files`);

  if (perception.diagnostics.typeErrors.length > 0) {
    const errors = perception.diagnostics.typeErrors
      .slice(0, 10)
      .map((e) => `  ${e.file}:${e.line}: ${clean(e.message)}`)
      .join('\n');
    sections.push(`[DIAGNOSTICS]\n${errors}`);
  }

  if (perception.verifiedFacts.length > 0) {
    const facts = perception.verifiedFacts
      .slice(0, 10)
      .map((f) => `  ${f.target}: ${clean(f.pattern)} (verified)`)
      .join('\n');
    sections.push(`[VERIFIED FACTS]\n${facts}`);
  }

  // CONSTRAINTS (failed approaches) — sanitized (LLM-generated text re-entering prompt)
  if (memory.failedApproaches.length > 0) {
    const constraints = memory.failedApproaches
      .map((f) => `  - Do NOT try: ${clean(f.approach)} (rejected: ${clean(f.oracleVerdict)})`)
      .join('\n');
    sections.push(`[CONSTRAINTS]\n${constraints}`);
  }

  // HYPOTHESES — sanitized (may contain cached skill approaches)
  if (memory.activeHypotheses.length > 0) {
    const hypotheses = memory.activeHypotheses
      .map((h) => `  - ${clean(h.hypothesis)} (confidence: ${h.confidence}, source: ${h.source})`)
      .join('\n');
    sections.push(`[HYPOTHESES]\n${hypotheses}`);
  }

  // UNCERTAINTIES
  if (memory.unresolvedUncertainties.length > 0) {
    const uncertainties = memory.unresolvedUncertainties
      .map((u) => `  - ${clean(u.area)}: ${clean(u.suggestedAction)}`)
      .join('\n');
    sections.push(`[UNCERTAINTIES]\n${uncertainties}`);
  }

  // PLAN (L2+ only) — sanitized (LLM-generated DAG descriptions)
  if (plan && plan.nodes.length > 0) {
    const steps = plan.nodes
      .map((n, i) => `  ${i + 1}. ${clean(n.description)} → ${n.targetFiles.join(', ')}`)
      .join('\n');
    sections.push(`[PLAN]\n${steps}`);
  }

  return sections.join('\n\n');
}
