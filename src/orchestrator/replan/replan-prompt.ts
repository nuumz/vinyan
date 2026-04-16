/**
 * Replan prompt builder — Wave 2. Instructs the LLM decomposer to propose a
 * STRUCTURALLY DIFFERENT plan, enumerating blockers + failed approaches.
 *
 * A1: the prompt only shapes candidate generation — acceptance/rejection is
 * performed by the rule-based ReplanEngine gates, not by the LLM itself.
 */
import type { ClassifiedFailure } from '../failure-classifier.ts';
import type { GoalSatisfaction } from '../goal-satisfaction/goal-evaluator.ts';
import type { PerceptualHierarchy, TaskInput, WorkingMemoryState } from '../types.ts';
import { buildFailurePatternLibrary } from './failure-pattern-library.ts';

export interface FailureContext {
  failedApproaches: WorkingMemoryState['failedApproaches'];
  goalSatisfaction: GoalSatisfaction;
  previousPlanDescription: string;
  iteration: number;
  /** Wave B: structured failure details from failure classifier. */
  classifiedFailures?: ClassifiedFailure[];
}

export function buildReplanPrompt(
  input: TaskInput,
  perception: PerceptualHierarchy,
  memory: WorkingMemoryState,
  failure: FailureContext,
): { systemPrompt: string; userPrompt: string } {
  const systemPrompt = `You are generating a REPLAN for a task whose previous plan failed.

Output ONLY valid JSON matching this schema:
{
  "nodes": [
    {
      "id": "string",
      "description": "string",
      "targetFiles": ["string"],
      "dependencies": ["string (IDs of prerequisite nodes)"],
      "assignedOracles": ["string"]
    }
  ]
}

REPLAN RULES — structural novelty is non-negotiable:
- Your job is to propose a STRUCTURALLY DIFFERENT strategy, NOT a refinement.
- If the previous plan used direct file edits, try a test-first approach.
- If the previous plan used a single-file refactor, try a split or a new helper.
- NEVER propose the same node structure (same IDs + same target files) as any prior plan.
- Use different verbs, different file partitions, different dependency shapes.
- If no novel approach is possible, return a single-node DAG whose description is
  "replan-exhausted" and leave assignedOracles empty — the engine will treat this
  as honest escalation.

DAG validity rules (still enforced):
- Each node targets specific files (no overlap between nodes)
- Dependencies form a DAG (no cycles)
- Every leaf node must have at least one assigned oracle
- Cover all files in the blast radius
- Use IDs like "n1", "n2", etc.`;

  const targetFiles = (input.targetFiles ?? []).join(', ') || 'not specified';
  const importees = perception.dependencyCone.directImportees.join(', ') || 'none';

  let userPrompt = `Goal: ${input.goal}

Target files: ${targetFiles}
Direct importees: ${importees}
Blast radius: ${perception.dependencyCone.transitiveBlastRadius} files

Replan attempt: ${failure.iteration}
Previous plan: ${failure.previousPlanDescription}`;

  if (failure.goalSatisfaction.failedChecks.length > 0) {
    userPrompt += `\n\nGoal checks that failed:\n${failure.goalSatisfaction.failedChecks.map((c) => `- ${c}`).join('\n')}`;
  }

  if (failure.goalSatisfaction.blockers.length > 0) {
    userPrompt += `\n\nBlockers:\n${failure.goalSatisfaction.blockers.map((b) => `- [${b.category}] ${b.detail}`).join('\n')}`;
  }

  if (input.constraints?.length) {
    userPrompt += `\n\nConstraints:\n${input.constraints.map((c) => `- ${c}`).join('\n')}`;
  }

  if (input.acceptanceCriteria?.length) {
    userPrompt += `\n\nAcceptance criteria:\n${input.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}`;
  }

  // Wave B: Structured failures with recovery hints (deterministic, A3-safe)
  if (failure.classifiedFailures?.length) {
    userPrompt += '\n\nClassified failures from prior attempt:';
    for (const cf of failure.classifiedFailures) {
      const loc = cf.file ? ` file=${cf.file}${cf.line ? `:${cf.line}` : ''}` : '';
      userPrompt += `\n[FAILURE category=${cf.category}${loc} severity=${cf.severity}] ${cf.message}`;
    }
    const hints = formatRecoveryHints(failure.classifiedFailures);
    if (hints) {
      userPrompt += `\n${hints}`;
    }
  }

  if (memory.failedApproaches.length > 0) {
    userPrompt += `\n\nDO NOT repeat these failed approaches:\n${memory.failedApproaches
      .map((a) => `- ${a.approach}: ${a.oracleVerdict}`)
      .join('\n')}`;
  }

  return { systemPrompt, userPrompt };
}

/**
 * Look up recovery hints from the failure pattern library for each
 * unique category in the classified failures. Deterministic (A3).
 */
function formatRecoveryHints(failures: ClassifiedFailure[]): string | null {
  const library = buildFailurePatternLibrary();
  const seen = new Set<string>();
  const hints: string[] = [];

  for (const f of failures) {
    if (seen.has(f.category)) continue;
    seen.add(f.category);
    const strategy = library.get(f.category);
    if (strategy) {
      hints.push(`[RECOVERY HINTS] ${strategy.recoveryHint}`);
    }
  }

  return hints.length > 0 ? hints.join('\n') : null;
}
