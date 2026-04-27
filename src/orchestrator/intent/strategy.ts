/**
 * Strategy classification — the deterministic tier of intent resolution.
 *
 * Extracted from `src/orchestrator/intent-resolver.ts` (plan commit D5).
 *
 * Three layers, low → high specificity:
 *   1. `fallbackStrategy` — plain mapping from (taskDomain, taskIntent,
 *      toolRequirement) to an ExecutionStrategy; used as LLM fallback
 *   2. `mapUnderstandingToStrategy` — takes the full SemanticTaskUnderstanding
 *      and returns { strategy, confidence, ambiguous } with ambiguity
 *      heuristics layered in
 *   3. `composeDeterministicCandidate` — combines the above with the
 *      classifyDirectTool primitive to produce a full IntentResolution
 *      skeleton, including a resolved shell command when confidence is high
 *
 * Pure: no LLM, no I/O, no caching.
 */

import type {
  ExecutionStrategy,
  IntentDeterministicCandidate,
  IntentResolution,
  SemanticTaskUnderstanding,
  TaskInput,
} from '../types.ts';
import { classifyDirectTool, resolveCommand } from '../tools/direct-tool-resolver.ts';

/**
 * Plain fallback mapping used when the LLM tier is unavailable or when
 * tier 0 produces no confident candidate. Kept as a narrow, deterministic
 * function so the LLM outage path has predictable behaviour.
 */
export function fallbackStrategy(
  taskDomain: string,
  taskIntent: string,
  toolRequirement: string,
  /**
   * Oracle-verified comprehension (optional). When present AND marks this
   * turn as a clarification answer, the fallback PRESERVES the workflow
   * path (agentic-workflow) even if the literal reply text ("โรแมนติก")
   * would otherwise read as conversational/inquire. Without this, LLM
   * outage + clarification-answer would silently re-route the user's
   * creative task to a chat reply.
   */
  comprehension?: import('../comprehension/types.ts').ComprehendedTaskMessage,
): ExecutionStrategy {
  if (
    comprehension?.params.type === 'comprehension' &&
    comprehension.params.data?.state.isClarificationAnswer
  ) {
    return 'agentic-workflow';
  }
  if (taskDomain === 'conversational') return 'conversational';
  if (taskDomain === 'general-reasoning' && taskIntent === 'inquire') return 'conversational';
  if (
    taskIntent === 'execute' &&
    toolRequirement === 'tool-needed' &&
    taskDomain !== 'code-mutation'
  )
    return 'direct-tool';
  // Creative/generative tasks (execute + no tools + general-reasoning) need
  // agentic-workflow, not full-pipeline.
  if (
    taskIntent === 'execute' &&
    toolRequirement === 'none' &&
    taskDomain === 'general-reasoning'
  )
    return 'agentic-workflow';
  return 'full-pipeline';
}

// Detect tokens that look like filenames (e.g. `src/foo.ts`, `README.md`).
const FILE_TOKEN_REGEX = /\b[\w.\-/]+\.[A-Za-z0-9]{1,6}\b/;

/**
 * Rule-based strategy candidate from STU signals. Higher-tier than
 * `fallbackStrategy` because it includes confidence + ambiguity detection.
 */
export function mapUnderstandingToStrategy(
  understanding: SemanticTaskUnderstanding,
): { strategy: ExecutionStrategy; confidence: number; ambiguous: boolean } {
  const { taskDomain, taskIntent, toolRequirement, rawGoal, resolvedEntities, targetSymbol } =
    understanding;
  const strategy = fallbackStrategy(taskDomain, taskIntent, toolRequirement);

  // --- Ambiguity heuristics ---
  // Goal looks like it references a file but entity resolver found nothing.
  const hasFileToken = FILE_TOKEN_REGEX.test(rawGoal);
  const hasResolvedPaths = resolvedEntities.some((e) => e.resolvedPaths.length > 0);
  const missingReferent = hasFileToken && !hasResolvedPaths && !targetSymbol;

  // "execute" intent on non-code domain with no clear tool signal — could be
  // creative generation OR a direct action OR a research workflow.
  const creativeAmbiguity =
    taskDomain === 'general-reasoning' &&
    taskIntent === 'execute' &&
    toolRequirement === 'none';

  // code-reasoning + inquire could be either "explain this code" (conversational)
  // or "analyze blame for bug" (full-pipeline with tools).
  const codeInquiryAmbiguity = taskDomain === 'code-reasoning' && taskIntent === 'inquire';

  const ambiguous = missingReferent || creativeAmbiguity || codeInquiryAmbiguity;

  // --- Confidence tiers (A5 heuristic ≈ 0.8, lowered for ambiguity) ---
  let confidence: number;
  if (ambiguous) {
    confidence = 0.55;
  } else if (taskDomain === 'conversational') {
    confidence = 0.95;
  } else if (
    taskDomain === 'code-mutation' &&
    (understanding.targetSymbol || resolvedEntities.length > 0)
  ) {
    confidence = 0.9;
  } else if (strategy === 'direct-tool') {
    confidence = 0.8;
  } else {
    confidence = 0.8;
  }

  return { strategy, confidence, ambiguous };
}

/**
 * Inspection/report verbs — tasks that need a TEXTUAL answer derived from
 * tool output, never fire-and-forget. Examples:
 *   - "ตรวจสอบการทำงานของ X" → report on X's status
 *   - "check git status"       → summarize working tree
 *   - "verify foo.ts compiles" → tell me the outcome
 *
 * These trigger `execute + tool-needed` in STU (the verb is imperative,
 * the task DOES need tools) but the intent is inquiry-with-tools. Route
 * them to `full-pipeline` so the oracle gate + DAG planner can marshal
 * multiple tools and produce a report.
 */
const INSPECTION_VERB_PATTERN =
  /(?:ตรวจสอบ|เช็ค|ดูสถานะ|ดูการทำงาน|รายงาน|สรุปสถานะ)|\b(?:check|inspect|verify|audit|diagnose|review|status|report)\b/i;

/**
 * High-precision creative-deliverable detection. Matches an imperative
 * authoring verb paired with a multi-section artifact noun within close
 * proximity. Split into two regexes because JS `\b` is ASCII-only and gives
 * no useful boundary between Thai code points — the Thai pattern relies on
 * the verb prefix + the proximity gap as the structural anchor instead.
 *
 * When this fires we override the LLM-comprehender's STU classification.
 * Rationale: the bedtime-story incident showed the comprehender labelling
 * "ช่วยเขียนนิยายก่อนนอน...สัก2บท" as `taskDomain=conversational`, which
 * cascaded into a `conversational-shortcircuit` that hallucinated delegation.
 * Goals matching this pattern are structurally agentic-workflow regardless
 * of how politely the user phrased them ("ช่วย", "could you").
 *
 * False-positive surface is deliberately small — verb + noun proximity is
 * required, and inquiry verbs ("คือ", "is", "what") are not in the verb set.
 * Bare nouns without an authoring verb ("นิยายคืออะไร", "what is a chapter")
 * are NOT matched. The pattern is checked BEFORE STU mapping so it pre-empts
 * wrong domain classification at the source.
 */
const CREATIVE_DELIVERABLE_THAI =
  /(เขียน|แต่ง|ประพันธ์|ร่าง|สร้าง|ออกแบบ)[^.!?]{0,40}(นิยาย|นิทาน|เรื่อง(?:สั้น|ราว|ยาว)?|บทความ|รายงาน|บท|ตอน|กลอน|สคริปต์)/i;

const CREATIVE_DELIVERABLE_ENGLISH =
  /\b(write|draft|compose|author|create|generate)\b[^.!?]{0,40}\b(story|stories|chapter|chapters|article|essay|report|poem|script|spec|outline|deck|novel|book)\b/i;

/**
 * True when the goal text is a structurally unambiguous creative-deliverable
 * request. Used by `composeDeterministicCandidate` to short-circuit
 * classification before the LLM advisory tier runs.
 */
function matchesCreativeDeliverable(text: string): boolean {
  return CREATIVE_DELIVERABLE_THAI.test(text) || CREATIVE_DELIVERABLE_ENGLISH.test(text);
}

/**
 * Compose a deterministic candidate from STU + rule-based tool classifier.
 * Returns an `IntentResolution` skeleton with `reasoningSource='deterministic'`.
 *
 * When both `classifyDirectTool` and `mapUnderstandingToStrategy` agree on
 * direct-tool, the result carries a fully-formed `directToolCall` (resolved
 * via platform-aware `resolveCommand`).
 */
export function composeDeterministicCandidate(
  input: TaskInput,
  understanding: SemanticTaskUnderstanding,
): IntentResolution & { deterministicCandidate: IntentDeterministicCandidate } {
  // Highest-priority pre-rule: explicit creative-deliverable pattern
  // overrides STU classification entirely. See CREATIVE_DELIVERABLE_PATTERN
  // doc for the rationale (bedtime-story comprehender mis-classification).
  // Confidence is set above DETERMINISTIC_SKIP_THRESHOLD so the resolver
  // bypasses the LLM advisory tier when the pattern matches — saves a
  // round-trip and prevents the LLM from second-guessing a structural fact.
  if (matchesCreativeDeliverable(input.goal)) {
    return {
      strategy: 'agentic-workflow',
      refinedGoal: input.goal,
      confidence: 0.9,
      reasoning:
        'Deterministic creative-deliverable pattern matched (verb + artifact noun proximity) — agentic-workflow forced regardless of STU classification.',
      reasoningSource: 'deterministic',
      type: 'known',
      deterministicCandidate: {
        strategy: 'agentic-workflow',
        confidence: 0.9,
        source: 'creative-deliverable-pattern',
        ambiguous: false,
      },
    };
  }

  const ruleStrategy = mapUnderstandingToStrategy(understanding);
  const directClass = classifyDirectTool(input.goal);
  const isInspection = INSPECTION_VERB_PATTERN.test(input.goal);
  // Inspection verbs normally route to full-pipeline ("they want a textual
  // report"). Exception: when the classifier produced a `shell_exec` with a
  // pre-resolved concrete command (e.g. `ls -la ~/Desktop` for "ตรวจสอบไฟล์
  // ~/Desktop/"), the inspection IS a direct shell call — running the
  // command and showing its output is the report. Skipping this carve-out
  // sends "ตรวจสอบไฟล์ <path>" through the full L2 workflow which then
  // hallucinates "ผมเข้าถึงไฟล์ไม่ได้" because it's just one LLM call with
  // no tools.
  const isResolvedShellInspection =
    !!directClass && directClass.type === 'shell_exec' && !!directClass.command;

  // Highest-confidence path: classifyDirectTool + rule-mapper both agree.
  if (
    directClass &&
    directClass.confidence >= 0.85 &&
    (!isInspection || isResolvedShellInspection) &&
    (ruleStrategy.strategy === 'direct-tool' ||
      understanding.toolRequirement === 'tool-needed' ||
      isResolvedShellInspection)
  ) {
    const command = resolveCommand(directClass, process.platform);
    if (command) {
      return {
        strategy: 'direct-tool',
        refinedGoal: input.goal,
        directToolCall: { tool: 'shell_exec', parameters: { command } },
        confidence: Math.min(directClass.confidence, ruleStrategy.ambiguous ? 0.75 : 0.9),
        reasoning: `Deterministic: classifyDirectTool matched (${directClass.type}, conf=${directClass.confidence}).`,
        reasoningSource: 'deterministic',
        type: 'known',
        deterministicCandidate: {
          strategy: 'direct-tool',
          confidence: Math.min(directClass.confidence, 0.9),
          source: 'composed',
          ambiguous: false,
        },
      };
    }
  }

  // Demotion path: rule said direct-tool but we could NOT resolve a concrete
  // shell command. A direct-tool strategy without a directToolCall is
  // semantically invalid — there is nothing to execute. Route to
  // full-pipeline instead, flagged ambiguous so the LLM merge layer becomes
  // the tiebreaker.
  //
  // Also catches inspection verbs that slipped through STU as
  // execute+tool-needed.
  if (ruleStrategy.strategy === 'direct-tool' || isInspection) {
    const reason = isInspection
      ? `STU ${understanding.taskDomain}/${understanding.taskIntent}/${understanding.toolRequirement} + inspection verb → full-pipeline (report expected, not fire-and-forget).`
      : `STU ${understanding.taskDomain}/${understanding.taskIntent}/${understanding.toolRequirement} → direct-tool rule fired but no shell command resolved; demoted to full-pipeline.`;
    return {
      strategy: 'full-pipeline',
      refinedGoal: input.goal,
      confidence: 0.55,
      reasoning: `Deterministic: ${reason}`,
      reasoningSource: 'deterministic',
      type: 'uncertain',
      deterministicCandidate: {
        strategy: 'full-pipeline',
        confidence: 0.55,
        source: 'mapUnderstandingToStrategy',
        ambiguous: true,
      },
    };
  }

  // Skeleton from the rule-mapper alone. No directToolCall or workflowPrompt
  // yet — the LLM layer fills those in when invoked.
  return {
    strategy: ruleStrategy.strategy,
    refinedGoal: input.goal,
    confidence: ruleStrategy.confidence,
    reasoning: `Deterministic: STU ${understanding.taskDomain}/${understanding.taskIntent}/${understanding.toolRequirement} → ${ruleStrategy.strategy}${ruleStrategy.ambiguous ? ' (ambiguous)' : ''}.`,
    reasoningSource: 'deterministic',
    type: ruleStrategy.ambiguous ? 'uncertain' : 'known',
    deterministicCandidate: {
      strategy: ruleStrategy.strategy,
      confidence: ruleStrategy.confidence,
      source: 'mapUnderstandingToStrategy',
      ambiguous: ruleStrategy.ambiguous,
    },
  };
}
