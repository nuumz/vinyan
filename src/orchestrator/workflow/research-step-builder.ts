/**
 * Research Step Builder — prepend an LLM-knowledge research step to workflows
 * when the goal calls for trends / audience / market context.
 *
 * A3 note: detection is pure regex (deterministic). The step itself dispatches
 * via `llm-reasoning`, which uses the LLM only to reason from its training
 * knowledge — no web fetch, no external state. This keeps Phase C's scope
 * "LLM knowledge only" as confirmed with the user.
 */

import type { WorkflowStep } from './types.ts';

/** Explicit cues from the user that research is desired. */
const EXPLICIT_RESEARCH_REGEX =
  /(ตลาด|เทรนด์|ยอดฮิต|กำลังดัง|กลุ่มเป้าหมาย|ผู้อ่าน|ผู้ชม|ยอดนิยม|เรตติ้ง|what'?s hot|\btrend(s|ing|y)?\b|\bmarket\b|audience|popular|research trend|current trend)/iu;

/**
 * Long-form creative deliverables that benefit from a trends / audience
 * grounding pass before drafting. Keep this narrow — we do NOT want a research
 * step prepended to every short reasoning task.
 */
const LONG_FORM_CREATIVE_REGEX =
  /(นิยาย|เว็บตูน|การ์ตูน|เรื่องสั้น|เรื่องยาว|บทความ|คอนเทนต์|คลิป|โพสต์|ebook|novel|webtoon|short story|article|screenplay|newsletter|blog ?post|book|ebook)/iu;

/**
 * Negation guard — short / informational utterances should never trigger the
 * research injector even when they accidentally name a deliverable noun.
 * Note: "what's" alone is too ambiguous (e.g. "what's trending" is a
 * research request, not an informational question), so we match specific
 * "what is <X>" / "explain what <X>" shapes instead.
 */
const RESEARCH_NEGATION_REGEX =
  /(แค่อยากรู้|คืออะไร|แปลว่า|หมายความว่า|ทำไม|just curious|\bwhat is\b|\bwhat does\b|\bexplain what\b|\bdefine what\b)/iu;

export interface ResearchCueDetection {
  /** Should a research step be injected at the top of the workflow? */
  needsResearch: boolean;
  /** Which detector fired (for observability). */
  reason?:
    | 'explicit-research-cue'
    | 'long-form-creative';
  /** Human-readable brief to inject into the step description. */
  brief?: string;
}

/**
 * Decide whether a workflow for `goal` should start with a research step.
 * Returns a brief when needed; returns `{ needsResearch: false }` otherwise.
 */
export function detectResearchCues(goal: string): ResearchCueDetection {
  const trimmed = goal.trim();
  if (trimmed.length < 8) return { needsResearch: false };
  if (RESEARCH_NEGATION_REGEX.test(trimmed)) return { needsResearch: false };

  if (EXPLICIT_RESEARCH_REGEX.test(trimmed)) {
    return {
      needsResearch: true,
      reason: 'explicit-research-cue',
      brief: 'Research current trends, market signals, and audience preferences relevant to the goal. Use LLM training knowledge only — do NOT attempt external web access.',
    };
  }

  if (LONG_FORM_CREATIVE_REGEX.test(trimmed)) {
    return {
      needsResearch: true,
      reason: 'long-form-creative',
      brief: 'Before drafting, research current trends, popular genres, and audience preferences for this creative topic. Use LLM training knowledge only.',
    };
  }

  return { needsResearch: false };
}

export const RESEARCH_STEP_ID = 'research-trends';

/** Build the canonical research step for prepending to a workflow plan. */
export function buildResearchStep(brief: string): WorkflowStep {
  return {
    id: RESEARCH_STEP_ID,
    description: brief,
    strategy: 'llm-reasoning',
    dependencies: [],
    inputs: {},
    expectedOutput:
      '3-5 bullet points covering: (1) current trending subgenres / formats, (2) audience demographic preferences, (3) competitive landscape signals, (4) open creative opportunities the user could exploit. Cite "LLM training knowledge" as the source; acknowledge the knowledge cutoff.',
    budgetFraction: 0.15,
  };
}

/**
 * Prepend the research step to an existing plan's steps and rewire
 * originally-root steps (dependencies === []) to depend on the research step,
 * so the research output flows into the rest of the pipeline.
 *
 * If a step with the research id already exists in `steps`, the original list
 * is returned unchanged — planner-generated research takes precedence.
 */
export function prependResearchStep(
  steps: WorkflowStep[],
  researchStep: WorkflowStep,
): WorkflowStep[] {
  if (steps.some((s) => s.id === researchStep.id)) return steps;

  const rewired = steps.map((s) =>
    s.dependencies.length === 0
      ? { ...s, dependencies: [researchStep.id] }
      : s,
  );

  // Down-scale original steps' budget fractions to keep total ≤ 1.0.
  const originalTotal = rewired.reduce((sum, s) => sum + (s.budgetFraction ?? 0), 0);
  const remaining = Math.max(0, 1 - researchStep.budgetFraction);
  const scale = originalTotal > 0 && originalTotal > remaining ? remaining / originalTotal : 1;
  const scaled = scale === 1 ? rewired : rewired.map((s) => ({
    ...s,
    budgetFraction: Number((s.budgetFraction * scale).toFixed(3)),
  }));

  return [researchStep, ...scaled];
}
