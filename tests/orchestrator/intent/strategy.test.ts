/**
 * Strategy classification tests (plan commit D5).
 *
 * Pins the three layers of deterministic classification:
 *   - fallbackStrategy
 *   - mapUnderstandingToStrategy (confidence + ambiguity signals)
 *   - composeDeterministicCandidate (happy-path + demotion variants)
 */
import { describe, expect, it } from 'bun:test';
import {
  composeDeterministicCandidate,
  enforceSubTaskLeafStrategy,
  fallbackStrategy,
  mapUnderstandingToStrategy,
} from '../../../src/orchestrator/intent/strategy.ts';
import type { IntentResolution, SemanticTaskUnderstanding, TaskInput } from '../../../src/orchestrator/types.ts';

function stu(over: Partial<SemanticTaskUnderstanding> = {}): SemanticTaskUnderstanding {
  return {
    rawGoal: 'do thing',
    taskDomain: 'code-mutation',
    taskIntent: 'execute',
    toolRequirement: 'none',
    resolvedEntities: [],
    semanticIntent: { pattern: 'default', implicitConstraints: [] },
    ...over,
  } as SemanticTaskUnderstanding;
}

function input(goal: string): TaskInput {
  return {
    id: 'i',
    source: 'cli',
    goal,
    taskType: 'code',
    budget: { maxTokens: 1000, maxDurationMs: 5000, maxRetries: 1 },
  };
}

describe('fallbackStrategy', () => {
  it('returns conversational for taskDomain=conversational', () => {
    expect(fallbackStrategy('conversational', 'chat', 'none')).toBe('conversational');
  });

  it('returns conversational for general-reasoning + inquire', () => {
    expect(fallbackStrategy('general-reasoning', 'inquire', 'none')).toBe('conversational');
  });

  it('returns direct-tool for non-code-mutation + execute + tool-needed', () => {
    expect(fallbackStrategy('general-reasoning', 'execute', 'tool-needed')).toBe('direct-tool');
  });

  it('returns agentic-workflow for general-reasoning + execute + none', () => {
    expect(fallbackStrategy('general-reasoning', 'execute', 'none')).toBe('agentic-workflow');
  });

  it('returns full-pipeline as the default', () => {
    expect(fallbackStrategy('code-mutation', 'execute', 'none')).toBe('full-pipeline');
  });

  it('preserves agentic-workflow on clarification answers', () => {
    const comprehension = {
      params: {
        type: 'comprehension' as const,
        inputHash: 'h',
        data: {
          state: { isClarificationAnswer: true },
        } as any,
      },
    } as any;
    // Even a pure "conversational" domain gets bumped to agentic-workflow.
    expect(fallbackStrategy('conversational', 'chat', 'none', comprehension)).toBe(
      'agentic-workflow',
    );
  });
});

describe('mapUnderstandingToStrategy', () => {
  it('marks conversational as high confidence and unambiguous', () => {
    const r = mapUnderstandingToStrategy(
      stu({ taskDomain: 'conversational', taskIntent: 'converse', toolRequirement: 'none' }),
    );
    expect(r.strategy).toBe('conversational');
    expect(r.confidence).toBeGreaterThanOrEqual(0.9);
    expect(r.ambiguous).toBe(false);
  });

  it('flags creative ambiguity (general-reasoning + execute + none)', () => {
    const r = mapUnderstandingToStrategy(
      stu({
        taskDomain: 'general-reasoning',
        taskIntent: 'execute',
        toolRequirement: 'none',
      }),
    );
    expect(r.ambiguous).toBe(true);
    expect(r.confidence).toBeLessThan(0.7);
  });

  it('flags code-reasoning inquiry as ambiguous', () => {
    const r = mapUnderstandingToStrategy(
      stu({ taskDomain: 'code-reasoning', taskIntent: 'inquire', toolRequirement: 'none' }),
    );
    expect(r.ambiguous).toBe(true);
  });

  it('flags missing-referent (file-token without resolved paths)', () => {
    const r = mapUnderstandingToStrategy(
      stu({
        rawGoal: 'refactor src/missing.ts',
        taskDomain: 'code-mutation',
        taskIntent: 'execute',
        toolRequirement: 'none',
        resolvedEntities: [],
      }),
    );
    expect(r.ambiguous).toBe(true);
  });

  it('gives code-mutation with target symbol high confidence', () => {
    const r = mapUnderstandingToStrategy(
      stu({
        taskDomain: 'code-mutation',
        taskIntent: 'execute',
        toolRequirement: 'none',
        targetSymbol: 'authenticate',
        resolvedEntities: [],
      } as Partial<SemanticTaskUnderstanding>),
    );
    expect(r.strategy).toBe('full-pipeline');
    expect(r.confidence).toBeGreaterThanOrEqual(0.85);
  });
});

describe('composeDeterministicCandidate', () => {
  it('returns deterministic reasoningSource + deterministicCandidate payload', () => {
    const result = composeDeterministicCandidate(
      input('say hi'),
      stu({ taskDomain: 'conversational', taskIntent: 'converse', toolRequirement: 'none' }),
    );
    expect(result.reasoningSource).toBe('deterministic');
    expect(result.deterministicCandidate).toBeDefined();
    expect(result.deterministicCandidate.strategy).toBe('conversational');
  });

  it('routes inspection verbs to full-pipeline with uncertain type', () => {
    const result = composeDeterministicCandidate(
      input('check git status'),
      stu({
        taskDomain: 'general-reasoning',
        taskIntent: 'execute',
        toolRequirement: 'tool-needed',
      }),
    );
    expect(result.strategy).toBe('full-pipeline');
    expect(result.type).toBe('uncertain');
    expect(result.reasoning).toMatch(/inspection verb|report expected/);
  });

  it('recognizes Thai inspection verbs', () => {
    const result = composeDeterministicCandidate(
      input('ตรวจสอบสถานะ repo'),
      stu({
        taskDomain: 'general-reasoning',
        taskIntent: 'execute',
        toolRequirement: 'tool-needed',
      }),
    );
    expect(result.strategy).toBe('full-pipeline');
  });

  it('emits skeleton with ambiguous=true for creative ambiguity', () => {
    const result = composeDeterministicCandidate(
      input('ช่วยคิดพล็อตนิยายหน่อย'),
      stu({
        taskDomain: 'general-reasoning',
        taskIntent: 'execute',
        toolRequirement: 'none',
      }),
    );
    expect(result.type).toBe('uncertain');
    expect(result.deterministicCandidate.ambiguous).toBe(true);
  });

  it('returns a full-pipeline skeleton for plain code-mutation', () => {
    const result = composeDeterministicCandidate(
      input('refactor the authenticate function'),
      stu({
        targetSymbol: 'authenticate',
        taskDomain: 'code-mutation',
        taskIntent: 'execute',
        toolRequirement: 'none',
      } as Partial<SemanticTaskUnderstanding>),
    );
    expect(result.strategy).toBe('full-pipeline');
    expect(result.type).toBe('known');
  });
});

describe('composeDeterministicCandidate — creative-deliverable pre-rule', () => {
  // The pre-rule is the bedtime-story bug fix. It runs BEFORE STU mapping
  // and overrides the comprehender's domain classification when the goal
  // text carries an unambiguous "verb + creative-noun" structural signal.
  it('catches the bedtime-story prompt at high confidence regardless of STU domain', () => {
    const result = composeDeterministicCandidate(
      input('ช่วยเขียนนิยายก่อนนอน สำหรับกล่อมลูกนอนให้สัก2บท'),
      // STU mis-classifies as conversational (the production failure mode).
      stu({ taskDomain: 'conversational', taskIntent: 'inquire', toolRequirement: 'none' }),
    );
    expect(result.strategy).toBe('agentic-workflow');
    expect(result.type).toBe('known');
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    expect(result.deterministicCandidate.source).toBe('creative-deliverable-pattern');
    expect(result.deterministicCandidate.ambiguous).toBe(false);
  });

  it('catches English authoring requests too', () => {
    const result = composeDeterministicCandidate(
      input('write me a 2-chapter bedtime story'),
      stu({ taskDomain: 'conversational', taskIntent: 'inquire', toolRequirement: 'none' }),
    );
    expect(result.strategy).toBe('agentic-workflow');
    expect(result.deterministicCandidate.source).toBe('creative-deliverable-pattern');
  });

  it('does NOT trigger on definition questions (verb absent)', () => {
    const result = composeDeterministicCandidate(
      input('นิยายเว็บตูนคืออะไร'),
      stu({ taskDomain: 'conversational', taskIntent: 'inquire', toolRequirement: 'none' }),
    );
    expect(result.strategy).toBe('conversational');
    expect(result.deterministicCandidate.source).not.toBe('creative-deliverable-pattern');
  });

  it('does NOT trigger on noun-collision performance tasks (verb is not authoring)', () => {
    // "ทำให้เว็บตูนโหลดเร็วขึ้น" mentions "เว็บตูน" (a noun also used in
    // creative writing) but the verb is "ทำให้...โหลดเร็วขึ้น" — performance.
    const result = composeDeterministicCandidate(
      input('ทำให้เว็บตูนโหลดเร็วขึ้น'),
      stu({ taskDomain: 'general-reasoning', taskIntent: 'execute', toolRequirement: 'none' }),
    );
    expect(result.deterministicCandidate.source).not.toBe('creative-deliverable-pattern');
  });

  it('does NOT trigger on bare creative noun without authoring verb', () => {
    const result = composeDeterministicCandidate(
      input('นิยายเรื่องนี้สนุกมาก'),
      stu({ taskDomain: 'conversational', taskIntent: 'inquire', toolRequirement: 'none' }),
    );
    expect(result.deterministicCandidate.source).not.toBe('creative-deliverable-pattern');
  });
});

describe('composeDeterministicCandidate — multi-agent delegation pre-rule', () => {
  // Pre-rule from session 44c83a53 incident — coordinator at routing level 0
  // hallucinated delegation because `delegate_task` requires L2+. Pattern
  // catches plural/numbered "agents" + delegation/competition verb and forces
  // agentic-workflow.
  it('catches "แบ่ง Agent 3ตัว แข่งกันถามตอบ" regardless of STU domain', () => {
    const result = composeDeterministicCandidate(
      input('แบ่ง Agent 3ตัว แข่งกันถามตอบ'),
      stu({ taskDomain: 'general-reasoning', taskIntent: 'inquire', toolRequirement: 'none' }),
    );
    expect(result.strategy).toBe('agentic-workflow');
    expect(result.type).toBe('known');
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
    expect(result.deterministicCandidate.source).toBe('multi-agent-delegation-pattern');
    expect(result.deterministicCandidate.ambiguous).toBe(false);
  });

  it('catches English "have 3 agents debate"', () => {
    const result = composeDeterministicCandidate(
      input('have 3 agents debate the merits of microservices'),
      stu({ taskDomain: 'general-reasoning', taskIntent: 'inquire', toolRequirement: 'none' }),
    );
    expect(result.strategy).toBe('agentic-workflow');
    expect(result.deterministicCandidate.source).toBe('multi-agent-delegation-pattern');
  });

  it('catches "split into multiple agents"', () => {
    const result = composeDeterministicCandidate(
      input('split this into multiple agents and let them compete'),
      stu({ taskDomain: 'general-reasoning', taskIntent: 'execute', toolRequirement: 'none' }),
    );
    expect(result.strategy).toBe('agentic-workflow');
    expect(result.deterministicCandidate.source).toBe('multi-agent-delegation-pattern');
  });

  it('does NOT trigger on singular "what is an agent"', () => {
    const result = composeDeterministicCandidate(
      input('what is an agent in vinyan'),
      stu({ taskDomain: 'general-reasoning', taskIntent: 'inquire', toolRequirement: 'none' }),
    );
    expect(result.deterministicCandidate.source).not.toBe('multi-agent-delegation-pattern');
  });

  it('does NOT trigger on conversational mention "the agent helped me"', () => {
    const result = composeDeterministicCandidate(
      input('the agent helped me find the answer yesterday'),
      stu({ taskDomain: 'conversational', taskIntent: 'inquire', toolRequirement: 'none' }),
    );
    expect(result.deterministicCandidate.source).not.toBe('multi-agent-delegation-pattern');
  });

  it('recursion guard: does NOT re-trigger when input.parentTaskId is set', () => {
    // Session 4e62ebe6 incident — a delegated sub-task's step description
    // ("Generate a response from the perspective of a Researcher, focusing
    // on agent diversity") still matched the multi-agent pattern, so the
    // sub-task launched ITS own delegate-sub-agent workflow. Task IDs
    // grew `…-delegate-step2-delegate-step2-delegate-step3-…` and the
    // wall-clock budget shrank exponentially per level (budgetMs=21,
    // reason "Wall-clock budget exhausted before next attempt could
    // start"). Multi-agent dispatch must be a TOP-LEVEL strategy only.
    const subTaskInput: TaskInput = {
      id: 'parent-1-delegate-step2',
      source: 'cli',
      goal: 'แบ่ง Agent 3ตัว แข่งกันถามตอบ',
      taskType: 'code',
      budget: { maxTokens: 1000, maxDurationMs: 5000, maxRetries: 1 },
      parentTaskId: 'parent-1', // ← marks this as a delegated sub-task
    };
    const result = composeDeterministicCandidate(
      subTaskInput,
      stu({ taskDomain: 'general-reasoning', taskIntent: 'inquire', toolRequirement: 'none' }),
    );
    expect(result.deterministicCandidate.source).not.toBe('multi-agent-delegation-pattern');
    expect(result.strategy).not.toBe('agentic-workflow');
  });
});

describe('composeDeterministicCandidate — sub-task recursion guard (STU mapper)', () => {
  // Reported on the Step-2-of-4 author-degeneration screenshot: the parent
  // workflow planned `step2: author — Develop a set of practical, high-
  // engagement coaching strategies and communication frameworks…`. The
  // delegate sub-task's STU classified that goal as
  // `general-reasoning + execute + none`, which the fallback strategy maps
  // to `agentic-workflow`. The sub-task then re-planned a NEW workflow,
  // re-injected the conversational shortcircuit's escape protocol, and the
  // free-tier author LLM paraphrased it ("the task is too big to handle
  // inline, use a agentic-workflow path") before degenerating into a
  // "topic-topic-topic-…" token loop. The guard must demote agentic-workflow
  // back to conversational so the sub-task runs as a single LLM call.
  it('demotes agentic-workflow → conversational when parentTaskId is set', () => {
    const subTaskInput: TaskInput = {
      id: 'parent-1-delegate-step2',
      source: 'cli',
      goal: 'Develop a set of practical, high-engagement coaching strategies and communication frameworks based on the psychological principles identified.',
      taskType: 'code',
      budget: { maxTokens: 1000, maxDurationMs: 5000, maxRetries: 1 },
      parentTaskId: 'parent-1',
    };
    const result = composeDeterministicCandidate(
      subTaskInput,
      stu({ taskDomain: 'general-reasoning', taskIntent: 'execute', toolRequirement: 'none' }),
    );
    expect(result.strategy).toBe('conversational');
    expect(result.deterministicCandidate.source).toBe('sub-task-recursion-guard');
    expect(result.reasoning).toMatch(/recursion guard|conversational/i);
  });

  it('does NOT demote at top level (parentTaskId absent)', () => {
    // Same STU shape, but a top-level task — the planner is the right
    // surface for `general-reasoning + execute + none`. Demotion would
    // regress every creative top-level task to a single-LLM-call answer.
    const result = composeDeterministicCandidate(
      input('Develop a coaching strategy doc'),
      stu({ taskDomain: 'general-reasoning', taskIntent: 'execute', toolRequirement: 'none' }),
    );
    expect(result.strategy).toBe('agentic-workflow');
    expect(result.deterministicCandidate.source).toBe('mapUnderstandingToStrategy');
  });

  it('skips creative-deliverable pre-rule for sub-tasks', () => {
    // A delegated sub-task whose description happens to match the creative-
    // deliverable verb+noun pattern (e.g. "draft chapter 2 prose") must NOT
    // re-fire the pre-rule — the parent already classified the task as
    // creative work. Re-firing routes the sub-task into another planner
    // round and explodes the call graph.
    const subTaskInput: TaskInput = {
      id: 'parent-1-delegate-step2',
      source: 'cli',
      goal: 'draft chapter 2 prose continuing from chapter 1',
      taskType: 'code',
      budget: { maxTokens: 1000, maxDurationMs: 5000, maxRetries: 1 },
      parentTaskId: 'parent-1',
    };
    const result = composeDeterministicCandidate(
      subTaskInput,
      stu({ taskDomain: 'general-reasoning', taskIntent: 'execute', toolRequirement: 'none' }),
    );
    expect(result.deterministicCandidate.source).not.toBe('creative-deliverable-pattern');
    expect(result.strategy).not.toBe('agentic-workflow');
  });
});

describe('enforceSubTaskLeafStrategy', () => {
  it('demotes fallback agentic-workflow decisions for delegated sub-tasks', () => {
    const resolution: IntentResolution = {
      strategy: 'agentic-workflow',
      refinedGoal: 'แบ่ง Agent 3ตัว แข่งกันถามตอบ',
      workflowPrompt: 'make a nested workflow',
      confidence: 0.5,
      reasoning: 'Fallback: regex-based (Intent resolution timeout)',
      reasoningSource: 'fallback',
      type: 'known',
    };

    const result = enforceSubTaskLeafStrategy(
      { parentTaskId: 'parent-1' },
      resolution,
    );

    expect(result.strategy).toBe('conversational');
    expect(result.workflowPrompt).toBeUndefined();
    expect(result.reasoning).toContain('sub-task leaf guard');
    expect(result.deterministicCandidate?.source).toBe('sub-task-recursion-guard');
  });

  it('leaves top-level multi-agent workflow decisions untouched', () => {
    const resolution: IntentResolution = {
      strategy: 'agentic-workflow',
      refinedGoal: 'แบ่ง Agent 3ตัว แข่งกันถามตอบ',
      workflowPrompt: 'top-level workflow',
      confidence: 0.9,
      reasoning: 'Deterministic multi-agent delegation pattern matched',
      reasoningSource: 'deterministic',
      type: 'known',
    };

    const result = enforceSubTaskLeafStrategy({}, resolution);

    expect(result).toBe(resolution);
    expect(result.strategy).toBe('agentic-workflow');
    expect(result.workflowPrompt).toBe('top-level workflow');
  });
});
