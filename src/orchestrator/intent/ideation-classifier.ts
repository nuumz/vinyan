/**
 * Ideation Classifier — deterministic rule-based detector for goals that
 * benefit from a Brainstorm phase before Perceive.
 *
 * A3-safe: pure function, no LLM, no I/O. Conservative — fires only on
 * explicit ideation verbs / question framings to avoid wasting brainstorm
 * budget on routine code-mutation tasks.
 *
 * Trigger heuristics (any rule passes → ideation candidate):
 *   1. Question framing: "what should...", "how can...", "ideas for..."
 *   2. Explicit ideation verbs: "brainstorm", "ideate", "explore options"
 *   3. Open-ended deliverable: "design", "propose", "compare approaches"
 *
 * Anti-triggers (suppress even if a rule matches):
 *   - Goal contains a concrete file path (e.g., "src/foo.ts") — already scoped.
 *   - Bug-fix verbs ("fix", "patch") — these have a known approach, not an
 *     ideation problem.
 */

// Note: \b boundaries do not work for Thai characters (Thai is \W in default
// regex), so the Thai alternatives are matched WITHOUT \b. The English
// alternatives keep \b to avoid sub-word matches like "designate" → "design".
const QUESTION_TRIGGER_EN = /^(what|how|why|which|should|where)\b/iu;
const QUESTION_TRIGGER_TH = /(จะ|ทำยังไง|ควร|วิธีไหน|ดีไหม|ตัวเลือก)/u;

const IDEATION_VERB_TRIGGER_EN =
  /\b(brainstorm|ideate|explore options|consider approaches|propose options|come up with|generate ideas)\b/iu;
const IDEATION_VERB_TRIGGER_TH =
  /(ระดมความคิด|ระดมไอเดีย|เสนอแนวทาง|เสนอไอเดีย|คิดทางเลือก)/u;

const OPEN_ENDED_TRIGGER_EN =
  /\b(design|propose|compare approaches?|evaluate options?|recommend|advise|trade-?offs?)\b/iu;
const OPEN_ENDED_TRIGGER_TH = /(ออกแบบ|เปรียบเทียบ|แนะนำ|ทางเลือก)/u;

const ANTI_TRIGGER_PATH =
  /(\.[tj]sx?|\.py|\.go|\.rs|\.md|\.json|\.yaml|\.yml|\.toml|\.html|\.css)\b|src\/[a-z0-9_/-]+|tests?\/[a-z0-9_/-]+/iu;

const ANTI_TRIGGER_BUGFIX_EN = /\b(fix|patch|hotfix|bugfix|repair|debug)\b/iu;
const ANTI_TRIGGER_BUGFIX_TH = /(แก้บั๊ก|แก้ไขข้อผิดพลาด)/u;

const MIN_GOAL_LENGTH = 10;

export interface IdeationClassification {
  /** True when the goal benefits from a Brainstorm phase. */
  isIdeation: boolean;
  /** Which rule fired ('none' when isIdeation=false). */
  matchedRule: 'question' | 'ideation-verb' | 'open-ended' | 'anti-path' | 'anti-bugfix' | 'too-short' | 'none';
  /** Pure debug payload — what the classifier saw. */
  signal: string;
}

/**
 * Decide whether the supplied goal should trigger phase-brainstorm.
 *
 * Returns a structured classification (not just a boolean) so callers can log
 * which rule fired and why a goal was rejected — important for tuning the
 * regexes without flying blind.
 */
export function classifyIdeation(goal: string): IdeationClassification {
  const trimmed = goal.trim();

  if (trimmed.length < MIN_GOAL_LENGTH) {
    return { isIdeation: false, matchedRule: 'too-short', signal: `len=${trimmed.length}` };
  }

  // Anti-triggers run FIRST — a goal with a concrete path or a bugfix verb
  // is never an ideation candidate, even if it also matches a question form.
  if (ANTI_TRIGGER_PATH.test(trimmed)) {
    return { isIdeation: false, matchedRule: 'anti-path', signal: 'concrete-file-path' };
  }
  if (ANTI_TRIGGER_BUGFIX_EN.test(trimmed) || ANTI_TRIGGER_BUGFIX_TH.test(trimmed)) {
    return { isIdeation: false, matchedRule: 'anti-bugfix', signal: 'bugfix-verb' };
  }

  if (IDEATION_VERB_TRIGGER_EN.test(trimmed) || IDEATION_VERB_TRIGGER_TH.test(trimmed)) {
    return { isIdeation: true, matchedRule: 'ideation-verb', signal: 'explicit-ideation-verb' };
  }
  if (QUESTION_TRIGGER_EN.test(trimmed) || QUESTION_TRIGGER_TH.test(trimmed)) {
    return { isIdeation: true, matchedRule: 'question', signal: 'question-framing' };
  }
  if (OPEN_ENDED_TRIGGER_EN.test(trimmed) || OPEN_ENDED_TRIGGER_TH.test(trimmed)) {
    return { isIdeation: true, matchedRule: 'open-ended', signal: 'open-ended-verb' };
  }

  return { isIdeation: false, matchedRule: 'none', signal: 'no-trigger-matched' };
}

/** Hard cap on number of drafter agents — keeps token cost bounded. */
export const MAX_BRAINSTORM_DRAFTERS = 3;
