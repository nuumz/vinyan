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
    expect(fallbackStrategy('conversational', 'chat', 'none', comprehension)).toBe('agentic-workflow');
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

  it('attaches a CollaborationDirective when the prompt carries count + rounds', () => {
    // Phase 1 wiring: the multi-agent branch parses a structured directive
    // and exposes it on IntentResolution so Phase 3's collaboration runner
    // can route to the Room dispatcher (text-answer mode) without going
    // through the workflow planner.
    const result = composeDeterministicCandidate(
      input('แบ่ง Agent 3ตัว แข่งกันถามตอบ และเพิ่มกระบวนการโต้แย้งกันเองได้อีก 2รอบ'),
      stu({ taskDomain: 'general-reasoning', taskIntent: 'inquire', toolRequirement: 'none' }),
    );
    expect(result.strategy).toBe('agentic-workflow');
    expect(result.collaboration).toBeDefined();
    expect(result.collaboration?.requestedPrimaryParticipantCount).toBe(3);
    expect(result.collaboration?.rebuttalRounds).toBe(2);
    expect(result.collaboration?.interactionMode).toBe('debate');
    expect(result.collaboration?.emitCompetitionVerdict).toBe(true);
    // Reasoning string surfaces the parsed shape so trace dashboards can
    // tell the directive-driven path apart from the legacy planner path.
    expect(result.reasoning).toMatch(/collaboration directive/i);
  });

  it('omits collaboration when the regex matches but no count is extractable', () => {
    // "agents debate" matches the structural English regex but carries no
    // count anchor — the deterministic candidate still forces
    // agentic-workflow (legacy planner path) but does NOT attach a
    // directive, so Phase 3 routing keeps using the workflow planner.
    const result = composeDeterministicCandidate(
      input('agents debate sometimes'),
      stu({ taskDomain: 'general-reasoning', taskIntent: 'inquire', toolRequirement: 'none' }),
    );
    expect(result.strategy).toBe('agentic-workflow');
    expect(result.collaboration).toBeUndefined();
  });
});

describe('composeDeterministicCandidate — execute vs mention routing (Phase 6)', () => {
  // Pins the load-bearing routing contract that prevents the live-session
  // bug (744a1546-58ad — Vinyan dispatched 3 LLM agents to debate a
  // META question about parser routing). The classifier in
  // `intent/collaboration-parser.ts` decides; the strategy layer enforces.
  //
  // A meta/quoted/example prompt that structurally matches the multi-agent
  // regex MUST NOT have its strategy forced to agentic-workflow AND MUST
  // NOT carry the collaboration directive — both signals are what
  // `core-loop.ts` reads to dispatch the collaboration runner.

  describe('execute prompts attach the collaboration directive AND force agentic-workflow', () => {
    const cases = [
      'แบ่ง Agent 3ตัว แข่งกันถามตอบ',
      'แบ่ง Agent 3ตัว แข่งกันถามตอบ และเพิ่มกระบวนการโต้แย้งกันเองได้อีก 2รอบ',
      'have 3 agents debate the merits of microservices',
      'have 3 agents compete and pick a winner',
    ];
    for (const goal of cases) {
      it(JSON.stringify(goal), () => {
        const result = composeDeterministicCandidate(
          input(goal),
          stu({ taskDomain: 'general-reasoning', taskIntent: 'inquire', toolRequirement: 'none' }),
        );
        expect(result.strategy).toBe('agentic-workflow');
        expect(result.collaboration).toBeDefined();
        expect(result.deterministicCandidate.source).toBe('multi-agent-delegation-pattern');
        expect(result.confidence).toBeGreaterThanOrEqual(0.85);
      });
    }
  });

  describe('mention prompts do NOT force the strategy and do NOT attach the directive', () => {
    // Each case asserts BOTH gates the core-loop dispatch reads:
    //   1. result.collaboration is undefined → core-loop's
    //      `if (collaborationDirective ...)` branch is skipped
    //   2. result.deterministicCandidate.source !== 'multi-agent-delegation-pattern'
    //      → the strategy was NOT force-overridden by the multi-agent rule;
    //      STU classified the prompt by its real intent
    const cases = [
      'ช่วยแก้ logic สำหรับ analyze user prompt เช่น "แบ่ง Agent 3ตัว แข่งกันถามตอบ"',
      'เขียน implementation plan สำหรับ prompt แบบ "แบ่ง Agent 3ตัว แข่งกันถามตอบ และเพิ่มกระบวนการโต้แย้งกันเองได้อีก 2รอบ"',
      'ออกแบบ parser ให้รองรับ have 3 agents debate',
      'ทำไม prompt "have 3 agents debate" ถึงถูก route ผิด',
      'review the routing logic for prompts like "แบ่ง Agent 3ตัว แข่งกันถามตอบ"',
    ];
    for (const goal of cases) {
      it(JSON.stringify(goal), () => {
        const result = composeDeterministicCandidate(
          input(goal),
          stu({ taskDomain: 'general-reasoning', taskIntent: 'inquire', toolRequirement: 'none' }),
        );
        expect(result.collaboration).toBeUndefined();
        expect(result.deterministicCandidate.source).not.toBe('multi-agent-delegation-pattern');
      });
    }
  });

  it('preserves the false-positive guard: "have 3 agents review the parser code" still executes', () => {
    // "review" + "parser" appear in the prompt but BOTH come AFTER the
    // multi-agent phrase — they are part of the agents' task, not framing
    // about the prompt. Position-gated meta detection in the classifier
    // protects this case so the user can legitimately ask 3 agents to
    // perform a code review without the gate misfiring.
    const result = composeDeterministicCandidate(
      input('have 3 agents review the parser code'),
      stu({ taskDomain: 'general-reasoning', taskIntent: 'inquire', toolRequirement: 'none' }),
    );
    expect(result.strategy).toBe('agentic-workflow');
    expect(result.deterministicCandidate.source).toBe('multi-agent-delegation-pattern');
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
    //
    // The deterministic creative-deliverable pre-rule may now claim this
    // path FIRST when the goal contains an authoring verb + artifact noun
    // (post-domain-coverage extension). Either source is acceptable as
    // long as the resulting strategy is `agentic-workflow` — that's the
    // invariant this test guards against the recursion-guard regression.
    const result = composeDeterministicCandidate(
      input('Develop a coaching strategy doc'),
      stu({ taskDomain: 'general-reasoning', taskIntent: 'execute', toolRequirement: 'none' }),
    );
    expect(result.strategy).toBe('agentic-workflow');
    expect(['mapUnderstandingToStrategy', 'creative-deliverable-pattern']).toContain(
      result.deterministicCandidate.source,
    );
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

describe('composeDeterministicCandidate — goalReferenceMode gating (Phase 1)', () => {
  // The architectural fix for the pre-rule false-activation bug class.
  //
  // composeDeterministicCandidate now accepts an optional `comprehension`
  // argument carrying the rule-comprehender's `goalReferenceMode`. The gate
  // applies UNIFORMLY to every surface-pattern pre-rule (multi-agent
  // delegation, creative-deliverable, …) — so adding a new pre-rule does
  // not require remembering to gate it; the helper does.
  //
  // Three modes the test pins:
  //   - 'direct':   pre-rule fires at PRE_RULE_DIRECT_CONFIDENCE (0.9), type=known
  //   - 'meta':     pre-rule yields to STU; result.collaboration MUST be
  //                 absent and source MUST NOT equal the pre-rule source
  //   - 'unknown':  pre-rule fires at PRE_RULE_UNKNOWN_CONFIDENCE (0.7) so
  //                 [B.skip] (DETERMINISTIC_SKIP_THRESHOLD=0.85) does NOT
  //                 bypass the LLM advisor. type='uncertain'.

  describe('multi-agent pre-rule', () => {
    it('fires at 0.9 when comprehension says direct', () => {
      const result = composeDeterministicCandidate(
        input('แบ่ง Agent 3ตัว แข่งกันถามตอบ'),
        stu({ taskDomain: 'general-reasoning', taskIntent: 'inquire', toolRequirement: 'none' }),
        { goalReferenceMode: 'direct' },
      );
      expect(result.strategy).toBe('agentic-workflow');
      expect(result.confidence).toBeGreaterThanOrEqual(0.85);
      expect(result.deterministicCandidate.source).toBe('multi-agent-delegation-pattern');
      expect(result.type).toBe('known');
      expect(result.collaboration).toBeDefined();
    });

    it('YIELDS to STU when comprehension says meta — no override, no directive', () => {
      // Even though `matchesMultiAgentDelegation` matches, the meta gate
      // blocks the override. The strategy returns whatever STU mapped to
      // (here general-reasoning + inquire → conversational), and the
      // collaboration directive is NOT attached. core-loop's runner gate
      // therefore never fires.
      const result = composeDeterministicCandidate(
        input('แบ่ง Agent 3ตัว แข่งกันถามตอบ'),
        stu({ taskDomain: 'general-reasoning', taskIntent: 'inquire', toolRequirement: 'none' }),
        { goalReferenceMode: 'meta' },
      );
      expect(result.deterministicCandidate.source).not.toBe('multi-agent-delegation-pattern');
      expect(result.collaboration).toBeUndefined();
      expect(result.strategy).not.toBe('agentic-workflow');
    });

    it('fires at 0.7 with type=uncertain when comprehension says unknown', () => {
      const result = composeDeterministicCandidate(
        input('แบ่ง Agent 3ตัว แข่งกันถามตอบ'),
        stu({ taskDomain: 'general-reasoning', taskIntent: 'inquire', toolRequirement: 'none' }),
        { goalReferenceMode: 'unknown' },
      );
      expect(result.strategy).toBe('agentic-workflow');
      expect(result.deterministicCandidate.source).toBe('multi-agent-delegation-pattern');
      expect(result.confidence).toBeLessThan(0.85);
      expect(result.confidence).toBeGreaterThanOrEqual(0.65);
      expect(result.type).toBe('uncertain');
      expect(result.deterministicCandidate.ambiguous).toBe(true);
      // Reasoning surfaces the demotion so trace dashboards can tell the
      // demoted-confidence path apart from the green path.
      expect(result.reasoning).toMatch(/goalReferenceMode=unknown/);
    });

    it('treats missing comprehension as direct (backwards compatible)', () => {
      // Callers that didn't run comprehension (LLM outage, unit tests
      // wiring the resolver directly) MUST keep the legacy green path.
      const result = composeDeterministicCandidate(
        input('แบ่ง Agent 3ตัว แข่งกันถามตอบ'),
        stu({ taskDomain: 'general-reasoning', taskIntent: 'inquire', toolRequirement: 'none' }),
        // no third argument
      );
      expect(result.strategy).toBe('agentic-workflow');
      expect(result.confidence).toBeGreaterThanOrEqual(0.85);
      expect(result.deterministicCandidate.source).toBe('multi-agent-delegation-pattern');
    });
  });

  describe('creative-deliverable pre-rule', () => {
    it('fires at 0.9 when comprehension says direct', () => {
      const result = composeDeterministicCandidate(
        input('เขียนนิยายสัก 2 บท'),
        stu({ taskDomain: 'conversational', taskIntent: 'inquire', toolRequirement: 'none' }),
        { goalReferenceMode: 'direct' },
      );
      expect(result.strategy).toBe('agentic-workflow');
      expect(result.confidence).toBeGreaterThanOrEqual(0.85);
      expect(result.deterministicCandidate.source).toBe('creative-deliverable-pattern');
    });

    it('YIELDS to STU when comprehension says meta', () => {
      // Without the gate, this prompt forces agentic-workflow and the
      // user's META question ("how does the parser handle this prompt?")
      // gets answered by a workflow planner instead of a chat reply.
      const result = composeDeterministicCandidate(
        input('ช่วยแก้ logic สำหรับ creative writing prompt เช่น "เขียนนิยายสัก 2 บท"'),
        stu({ taskDomain: 'conversational', taskIntent: 'inquire', toolRequirement: 'none' }),
        { goalReferenceMode: 'meta' },
      );
      expect(result.deterministicCandidate.source).not.toBe('creative-deliverable-pattern');
      expect(result.strategy).not.toBe('agentic-workflow');
    });

    it('fires at 0.7 with type=uncertain when comprehension says unknown', () => {
      const result = composeDeterministicCandidate(
        input('เขียนนิยายสัก 2 บท'),
        stu({ taskDomain: 'conversational', taskIntent: 'inquire', toolRequirement: 'none' }),
        { goalReferenceMode: 'unknown' },
      );
      expect(result.strategy).toBe('agentic-workflow');
      expect(result.deterministicCandidate.source).toBe('creative-deliverable-pattern');
      expect(result.confidence).toBeLessThan(0.85);
      expect(result.type).toBe('uncertain');
      expect(result.deterministicCandidate.ambiguous).toBe(true);
    });
  });

  describe('cross-rule generality', () => {
    // The architectural claim: ONE comprehension signal protects EVERY
    // pre-rule. These tests assert the claim by checking that a single
    // 'meta' value blocks BOTH multi-agent and creative-deliverable
    // overrides without per-rule logic.
    it('a meta classification blocks both multi-agent and creative-deliverable in one pass', () => {
      // Combined prompt that would trigger BOTH pre-rules without the gate.
      const combined = composeDeterministicCandidate(
        input('have 3 agents write a 2-chapter bedtime story'),
        stu({ taskDomain: 'general-reasoning', taskIntent: 'inquire', toolRequirement: 'none' }),
        { goalReferenceMode: 'meta' },
      );
      expect(combined.deterministicCandidate.source).not.toBe('multi-agent-delegation-pattern');
      expect(combined.deterministicCandidate.source).not.toBe('creative-deliverable-pattern');
      expect(combined.collaboration).toBeUndefined();
    });
  });

  describe('regression: direct-execution prompts stay green', () => {
    // The user explicitly called this out as the must-not-regress contract.
    // Each of these classifies as 'direct' (per goal-reference-mode tests)
    // and MUST yield a high-confidence pre-rule fire.
    const cases: ReadonlyArray<readonly [string, 'multi-agent-delegation-pattern' | 'creative-deliverable-pattern']> = [
      ['แบ่ง Agent 3ตัว แข่งกันถามตอบ', 'multi-agent-delegation-pattern'],
      ['เขียนนิยายสัก 2 บท', 'creative-deliverable-pattern'],
      ['have 3 agents debate microservices', 'multi-agent-delegation-pattern'],
      ['have 3 agents review the parser code', 'multi-agent-delegation-pattern'],
    ];
    for (const [goal, expectedSource] of cases) {
      it(`${JSON.stringify(goal)} → ${expectedSource}`, () => {
        const result = composeDeterministicCandidate(
          input(goal),
          stu({ taskDomain: 'general-reasoning', taskIntent: 'inquire', toolRequirement: 'none' }),
          { goalReferenceMode: 'direct' },
        );
        expect(result.strategy).toBe('agentic-workflow');
        expect(result.confidence).toBeGreaterThanOrEqual(0.85);
        expect(result.deterministicCandidate.source).toBe(expectedSource);
      });
    }
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

    const result = enforceSubTaskLeafStrategy({ parentTaskId: 'parent-1' }, resolution);

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

  it('strips the CollaborationDirective from a demoted sub-task leaf', () => {
    // The collaboration runner is a TOP-LEVEL contract — a sub-task that
    // somehow inherits a directive (e.g. via clarification re-resolution
    // during a delegated child) must not trigger another room dispatch
    // inside the parent's running participant turn. The leaf guard demotes
    // strategy AND clears the directive in one pass.
    const resolution: IntentResolution = {
      strategy: 'agentic-workflow',
      refinedGoal: 'แบ่ง Agent 3ตัว แข่งกันถามตอบ',
      workflowPrompt: 'nested workflow',
      confidence: 0.9,
      reasoning: 'directive carried through',
      reasoningSource: 'deterministic',
      type: 'known',
      collaboration: {
        requestedPrimaryParticipantCount: 3,
        interactionMode: 'debate',
        rebuttalRounds: 2,
        sharedDiscussion: true,
        reviewerPolicy: 'none',
        managerClarificationAllowed: true,
        emitCompetitionVerdict: true,
        source: 'pre-llm-parser',
        matchedFragments: { count: '3ตัว', rounds: '2รอบ' },
      },
    };

    const result = enforceSubTaskLeafStrategy({ parentTaskId: 'parent-1' }, resolution);

    expect(result.strategy).toBe('conversational');
    expect(result.collaboration).toBeUndefined();
    expect(result.workflowPrompt).toBeUndefined();
  });
});
