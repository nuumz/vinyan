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

import { classifyDirectTool, resolveCommand } from '../tools/direct-tool-resolver.ts';
import type {
  ExecutionStrategy,
  IntentDeterministicCandidate,
  IntentResolution,
  SemanticTaskUnderstanding,
  TaskInput,
} from '../types.ts';
import { parseCollaborationDirective } from './collaboration-parser.ts';

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

/**
 * Delegated sub-tasks are workflow leaves. If any resolver path still returns
 * `agentic-workflow` for a sub-task, collapse it to one conversational LLM
 * answer so delegates cannot recursively launch child workflows.
 */
export function enforceSubTaskLeafStrategy(
  input: Pick<TaskInput, 'parentTaskId'>,
  resolution: IntentResolution,
): IntentResolution {
  if (!input.parentTaskId || resolution.strategy !== 'agentic-workflow') return resolution;

  const {
    directToolCall: _directToolCall,
    externalCodingCli: _externalCodingCli,
    workflowPrompt: _workflowPrompt,
    // Collaboration directive is a TOP-LEVEL contract — a delegated sub-task
    // must never see it, otherwise the collaboration runner would recursively
    // open a room inside an already-running participant turn.
    collaboration: _collaboration,
    ...leaf
  } = resolution;
  return {
    ...leaf,
    strategy: 'conversational',
    confidence: Math.min(resolution.confidence, 0.7),
    reasoning:
      `${resolution.reasoning} [sub-task leaf guard: parentTaskId present, demoted agentic-workflow → conversational to prevent nested workflow recursion]`,
    reasoningSource: resolution.reasoningSource ?? 'deterministic',
    deterministicCandidate: {
      strategy: 'conversational',
      confidence: Math.min(resolution.confidence, 0.7),
      source: 'sub-task-recursion-guard',
      ambiguous: false,
    },
  };
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
 * Multi-agent delegation patterns. Mirrors the creative-deliverable rule:
 * a structural signal (plural/numbered "agents" + delegation/competition verb)
 * forces `agentic-workflow` so the coordinator persona has access to the
 * `delegate_task` tool (which requires routingLevel ≥ 2).
 *
 * Without this rule, "แบ่ง Agent 3ตัว แข่งกันถามตอบ" classified as
 * `general-reasoning + inquire` cascades to `conversational` strategy at
 * routing level 0/1, where coordinator has NO delegation capability and
 * hallucinates "ส่งโจทย์ไปยัง Developer และ Mentor แล้ว" without any
 * sub-task being created. The 2026-04-28 incident on session 44c83a53
 * showed the model literally admitting "ผมอยู่ในโหมดสนทนาสั้น...หากต้องการ
 * ให้ผมจำลองคำตอบของทั้งคู่ขึ้นมาเลย โปรดแจ้งได้".
 *
 * Anchor: number-or-multiplicity-quantifier + "agent(s)" within close
 * proximity, OR "agent(s)" + competition/delegation verb. Bare "agent"
 * (singular, no quantifier, no verb) is intentionally NOT matched — that is
 * legitimate conversational mention.
 */
const MULTI_AGENT_THAI =
  /(?:แบ่ง|หลาย|ใช้|มี|spawn)[^.!?]{0,20}(?:\d+\s*)?agents?(?:[^.!?]{0,20}(?:แข่ง|ประชัน|ทำงาน|ดีเบต|ตอบกัน|ถามตอบ|ตอบ|ถาม|ร่วม|coordinate|debate|battle|compete))?/i;

const MULTI_AGENT_ENGLISH =
  /\b(?:multiple|several|two|three|four|five|many|\d+)\s+agents?\b|\bsplit\s+(?:into|among|across)\s+(?:\d+\s+)?agents?\b|\bagents?\s+(?:compete|debate|battle|cooperate|coordinate|race|debate)\b|\b(?:have|let|spawn)\s+(?:\d+\s+)?agents?\s+(?:compete|debate|work|answer|race)\b/i;

/**
 * Exported so `intent/collaboration-parser.ts` can gate its richer extraction
 * on the same structural anchor. Keep the predicate's caller list small —
 * downstream consumers should call `parseCollaborationDirective` instead and
 * rely on its `null` return for negative cases.
 */
export function matchesMultiAgentDelegation(text: string): boolean {
  // Thai pattern requires the multiplicity prefix AND "agent" — the prefix
  // alone is too noisy. The English pattern is more selective by structure.
  // Both fire only when there is a clear plural-agent or delegation signal.
  if (MULTI_AGENT_ENGLISH.test(text)) return true;
  // Thai pattern: require at least one number token nearby OR a multi-agent
  // prefix tied directly to "agent". The regex already encodes proximity;
  // add a sanity cross-check that "agent" actually appears.
  if (/agents?/i.test(text) && MULTI_AGENT_THAI.test(text)) return true;
  return false;
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
  // Recursion guard root flag. Sub-tasks (anything dispatched via
  // delegate-sub-agent) carry `parentTaskId` from the workflow executor.
  // Both forced-agentic-workflow pre-rules below and the STU mapper's
  // `general-reasoning + execute + none → agentic-workflow` line further
  // down are TOP-LEVEL-only contracts — re-entering them inside a sub-task
  // recurses into another workflow plan, which:
  //   1. Compounds budget fractions per level (session 4e62ebe6 hit
  //      budgetMs=21 with reason "Wall-clock budget exhausted before next
  //      attempt could start").
  //   2. Re-injects the conversational shortcircuit's escape-protocol
  //      stanza into the sub-agent's persona prompt, which the LLM then
  //      paraphrases ("the task is too big to handle inline, use a
  //      agentic-workflow path") and degenerates into a token loop —
  //      observed as the "topic-topic-topic-…" tail in the author-step
  //      stream on session-with-Step-2-of-4 reports.
  // The guard collapses every nested-workflow path back to a single LLM
  // call. The conversational-result-builder additionally drops the escape
  // protocol when `parentTaskId` is set, so the sub-agent sees its persona
  // soul + peer roster only and answers the step directly.
  const isSubTask = !!input.parentTaskId;

  // Highest-priority pre-rule: multi-agent delegation pattern overrides STU
  // classification entirely. See MULTI_AGENT_THAI/MULTI_AGENT_ENGLISH doc for
  // rationale (session 44c83a53 incident — coordinator at L0 hallucinated
  // delegation because `delegate_task` requires L2+). Forcing
  // `agentic-workflow` here gives coordinator the delegate_task capability so
  // the request is fulfilled instead of mocked in prose. Top-level only.
  if (!isSubTask && matchesMultiAgentDelegation(input.goal)) {
    // Phase 1: extract the structured CollaborationDirective from the prompt
    // text. When present, downstream wiring (Phase 3) routes the strategy
    // through the Room text-answer dispatcher so the same N participants
    // persist across rebuttal rounds. When the parser cannot extract a
    // count, we still force agentic-workflow (legacy behaviour) but the
    // collaboration field is left undefined and the planner path runs.
    const collaboration = parseCollaborationDirective(input.goal);
    return {
      strategy: 'agentic-workflow',
      refinedGoal: input.goal,
      confidence: 0.9,
      reasoning: collaboration
        ? `Deterministic multi-agent collaboration directive parsed (count=${collaboration.requestedPrimaryParticipantCount}, mode=${collaboration.interactionMode}, rebuttalRounds=${collaboration.rebuttalRounds}) — agentic-workflow forced; collaboration runner will dispatch a persistent-participant room.`
        : 'Deterministic multi-agent delegation pattern matched (plural/numbered "agents" + delegation/competition verb) — agentic-workflow forced so coordinator has delegate_task access.',
      reasoningSource: 'deterministic',
      type: 'known',
      deterministicCandidate: {
        strategy: 'agentic-workflow',
        confidence: 0.9,
        source: 'multi-agent-delegation-pattern',
        ambiguous: false,
      },
      ...(collaboration ? { collaboration } : {}),
    };
  }

  // Highest-priority pre-rule: explicit creative-deliverable pattern
  // overrides STU classification entirely. See CREATIVE_DELIVERABLE_PATTERN
  // doc for the rationale (bedtime-story comprehender mis-classification).
  // Confidence is set above DETERMINISTIC_SKIP_THRESHOLD so the resolver
  // bypasses the LLM advisory tier when the pattern matches — saves a
  // round-trip and prevents the LLM from second-guessing a structural fact.
  // Top-level only — the parent workflow already decided this is creative
  // work; nested sub-task descriptions like "draft chapter 2 prose" must
  // not re-plan as their own workflow.
  if (!isSubTask && matchesCreativeDeliverable(input.goal)) {
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

  // Sub-task safety net: collapse any agentic-workflow that fell out of the
  // STU mapper (general-reasoning + execute + none → agentic-workflow per
  // `fallbackStrategy`) back to conversational. A delegated sub-task is
  // already inside a workflow; running another planner inside leads to
  // exponential budget shrinkage and the prompt-confusion token loop
  // documented on `isSubTask` above. The conversational path is the right
  // single-LLM-call fallback — the persona produces the step's deliverable
  // directly, the executor takes its answer back as the step output.
  let finalStrategy: ExecutionStrategy = ruleStrategy.strategy;
  let finalConfidence = ruleStrategy.confidence;
  let finalSource: IntentDeterministicCandidate['source'] = 'mapUnderstandingToStrategy';
  let extraReasoning = '';
  if (isSubTask && finalStrategy === 'agentic-workflow') {
    finalStrategy = 'conversational';
    // Demoted strategy is a recursion-safety choice, not an organic STU
    // signal — keep confidence in the heuristic band (0.7) so the LLM
    // advisory tier is still allowed to second-guess if it has stronger
    // evidence the sub-step truly needs a sub-workflow (it almost never
    // does — caller is the workflow planner itself).
    finalConfidence = 0.7;
    finalSource = 'sub-task-recursion-guard';
    extraReasoning = ' (sub-task recursion guard demoted agentic-workflow → conversational)';
  }

  // Skeleton from the rule-mapper alone. No directToolCall or workflowPrompt
  // yet — the LLM layer fills those in when invoked.
  return {
    strategy: finalStrategy,
    refinedGoal: input.goal,
    confidence: finalConfidence,
    reasoning: `Deterministic: STU ${understanding.taskDomain}/${understanding.taskIntent}/${understanding.toolRequirement} → ${finalStrategy}${ruleStrategy.ambiguous ? ' (ambiguous)' : ''}${extraReasoning}.`,
    reasoningSource: 'deterministic',
    type: ruleStrategy.ambiguous ? 'uncertain' : 'known',
    deterministicCandidate: {
      strategy: finalStrategy,
      confidence: finalConfidence,
      source: finalSource,
      ambiguous: ruleStrategy.ambiguous,
    },
  };
}
