/**
 * Conversational result builder — persona resolution priority.
 *
 * Pins the contract that resolved-persona priority is:
 *   intent.agentId  →  input.agentId  →  registry.defaultAgent()
 *
 * Without this, a delegate-sub-agent that falls through to the
 * conversational short-circuit (e.g. when intent.agentId is unset because
 * STU classified the sub-task as conversational) reverts to the default
 * `coordinator` persona and loses the planner-assigned `author / mentor /
 * researcher` identity. Session a43487fd showed delegates speaking with
 * the coordinator soul instead of their assigned persona — root cause for
 * "competition rule proposals" in place of actual answers.
 */
import { describe, expect, test } from 'bun:test';
import { asPersonaId } from '../../src/core/agent-vocabulary.ts';
import { buildConversationalResult } from '../../src/orchestrator/conversational-result-builder.ts';
import type { DerivedCapabilities } from '../../src/orchestrator/agents/derive-persona-capabilities.ts';
import type { SkillMdRecord } from '../../src/skills/skill-md/index.ts';
import type {
  AgentSpec,
  HistoryMessage,
  IntentResolution,
  TaskInput,
} from '../../src/orchestrator/types.ts';

function makeInput(over: Partial<TaskInput> = {}): TaskInput {
  return {
    id: 'task-1',
    source: 'cli',
    goal: 'hello',
    taskType: 'reasoning',
    budget: { maxTokens: 1000, maxDurationMs: 5000, maxRetries: 1 },
    ...over,
  };
}

function intent(over: Partial<IntentResolution> = {}): IntentResolution {
  return {
    strategy: 'conversational',
    refinedGoal: 'hello',
    confidence: 0.9,
    reasoning: 'test',
    reasoningSource: 'deterministic',
    type: 'known',
    ...over,
  } as IntentResolution;
}

const COORDINATOR: AgentSpec = {
  id: 'coordinator',
  name: 'Coordinator',
  description: 'default routing persona',
  builtin: true,
  routingHints: { minLevel: 0 },
  capabilities: [],
  acquirableSkillTags: [],
  soul: 'I route work.',
} as unknown as AgentSpec;

const AUTHOR: AgentSpec = {
  id: 'author',
  name: 'Author',
  description: 'creative writing persona',
  builtin: true,
  routingHints: { minLevel: 0 },
  capabilities: [],
  acquirableSkillTags: [],
  soul: 'I write.',
} as unknown as AgentSpec;

/**
 * Minimal `SkillMdRecord` factory for skill-card injection tests. Only the
 * fields that `toSkillCardView` reads are filled; the rest are populated to
 * satisfy the schema-compatible interface. Callers pass a sentinel string
 * via `whenToUse` so the rendered envelope can be asserted on.
 */
function stubSkill(opts: { id: string; whenToUse: string }): SkillMdRecord {
  return {
    frontmatter: {
      id: opts.id,
      name: opts.id,
      version: '1.0.0',
      description: `${opts.id} test skill`,
      requires_toolsets: [],
      fallback_for_toolsets: [],
      confidence_tier: 'heuristic',
      origin: 'local',
      declared_oracles: [],
      falsifiable_by: [],
      status: 'active',
    } as SkillMdRecord['frontmatter'],
    body: {
      overview: 'overview',
      whenToUse: opts.whenToUse,
      procedure: 'procedure',
    },
    contentHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
  };
}

interface DepsOpts {
  capturedSystemPrompt: string[];
  workerIdSink: string[];
  /** Per-agent soul override (loadSoulRaw lookup). Wins over AgentSpec.soul. */
  soulMap?: Record<string, string>;
  /**
   * Per-agent derived-capability override. When omitted, the registry mock
   * does NOT implement `getDerivedCapabilities` (mirrors narrow legacy mocks
   * the optional-chained guard must tolerate).
   */
  derivedMap?: Record<string, DerivedCapabilities | null>;
  /** Session turns history returned by `getTurnsHistory`. Empty = none. */
  sessionTurns?: Array<{ role: 'user' | 'assistant'; text: string }>;
  /** Captures the `messages` HistoryMessage[] passed to provider.generate. */
  capturedMessages?: Array<HistoryMessage[] | undefined>;
  /** Optional roster override; defaults to [COORDINATOR, AUTHOR]. */
  roster?: AgentSpec[];
}

function makeDeps(opts: DepsOpts): any {
  const roster = opts.roster ?? [COORDINATOR, AUTHOR];
  const provider = {
    id: 'mock',
    tier: 'fast' as const,
    generate: async (req: {
      systemPrompt: string;
      userPrompt: string;
      messages?: HistoryMessage[];
    }) => {
      opts.capturedSystemPrompt.push(req.systemPrompt);
      opts.capturedMessages?.push(req.messages);
      return { content: 'ok', tokensUsed: { input: 1, output: 1 } };
    },
  };
  const traces: any[] = [];
  // Only attach `getDerivedCapabilities` to the registry mock when the test
  // supplies a derivedMap. This pins the contract that the conversational
  // call site optional-chains the lookup so older deps shapes that omit the
  // method continue to work (legacy / minimal test setups).
  const agentRegistry: any = {
    defaultAgent: () => COORDINATOR,
    getAgent: (id: string) => roster.find((a) => a.id === id) ?? null,
    listAgents: () => roster,
  };
  if (opts.derivedMap) {
    agentRegistry.getDerivedCapabilities = (id: string) => opts.derivedMap?.[id] ?? null;
  }
  // Same pattern for soulStore: only present when explicitly opted in.
  const soulStore = opts.soulMap
    ? {
        loadSoulRaw: (id: string) => opts.soulMap?.[id] ?? null,
      }
    : undefined;
  // SessionManager only present when sessionTurns is supplied — matches the
  // production wiring where SessionManager is optional.
  const sessionManager = opts.sessionTurns
    ? {
        getTurnsHistory: (_id: string, _n?: number) =>
          (opts.sessionTurns ?? []).map((t) => ({
            role: t.role,
            blocks: [{ type: 'text', text: t.text }],
          })),
      }
    : undefined;
  return {
    llmRegistry: {
      selectByTier: () => provider,
      listProviders: () => [provider],
    },
    agentRegistry,
    soulStore,
    sessionManager,
    traceCollector: {
      record: async (t: any) => {
        traces.push(t);
        opts.workerIdSink.push(t.workerId);
      },
    },
    bus: { emit: () => {} },
  };
}

describe('buildConversationalResult — persona resolution priority', () => {
  test('input.agentId wins when intent.agentId is undefined (delegate sub-task fallback)', async () => {
    // The delegate-sub-agent dispatch site sets `subInput.agentId = 'author'`
    // but does NOT set `intent.agentId`. Before the fix, the conversational
    // resolver only checked intent.agentId and reverted to the default
    // coordinator soul — the author delegate spoke with the wrong voice.
    const capturedSystemPrompt: string[] = [];
    const workerIdSink: string[] = [];
    const deps = makeDeps({ capturedSystemPrompt, workerIdSink });
    const result = await buildConversationalResult(
      makeInput({ agentId: asPersonaId('author') }),
      intent(), // intent.agentId is undefined
      deps,
    );
    expect(result.kind).toBe('final');
    expect(workerIdSink[0]).toBe('author');
    expect(capturedSystemPrompt[0]).toContain('Author');
    expect(capturedSystemPrompt[0]).toContain('I write.');
    // Coordinator soul must NOT be the active persona for this turn.
    expect(capturedSystemPrompt[0]).not.toContain('I route work.');
  });

  test('intent.agentId wins over input.agentId when both are set', async () => {
    // Intent-resolver had a strong signal (e.g. a skill auction picked a
    // different specialist than the parent's hint). intent.agentId is the
    // higher-priority source — input.agentId is only a fallback.
    const capturedSystemPrompt: string[] = [];
    const workerIdSink: string[] = [];
    const deps = makeDeps({ capturedSystemPrompt, workerIdSink });
    await buildConversationalResult(
      makeInput({ agentId: asPersonaId('coordinator') }),
      intent({ agentId: asPersonaId('author') } as Partial<IntentResolution>),
      deps,
    );
    expect(workerIdSink[0]).toBe('author');
    expect(capturedSystemPrompt[0]).toContain('I write.');
  });

  test('falls back to defaultAgent when neither agentId is set', async () => {
    const capturedSystemPrompt: string[] = [];
    const workerIdSink: string[] = [];
    const deps = makeDeps({ capturedSystemPrompt, workerIdSink });
    await buildConversationalResult(makeInput(), intent(), deps);
    expect(workerIdSink[0]).toBe('coordinator');
    expect(capturedSystemPrompt[0]).toContain('I route work.');
  });
});

// ── Sub-agent independence: soul, runtime skills, peer + session isolation ──

const RESEARCHER: AgentSpec = {
  id: 'researcher',
  name: 'Researcher',
  description: 'investigates and synthesizes evidence',
  builtin: true,
  routingHints: { minLevel: 0 },
  capabilities: [],
  acquirableSkillTags: [],
  soul: 'I research.',
} as unknown as AgentSpec;

const MENTOR: AgentSpec = {
  id: 'mentor',
  name: 'Mentor',
  description: 'critiques and refines',
  builtin: true,
  routingHints: { minLevel: 0 },
  capabilities: [],
  acquirableSkillTags: [],
  soul: 'I critique.',
} as unknown as AgentSpec;

const COORDINATOR_PEER_SENTINEL_C4P = 'COORDINATOR_PEER_SENTINEL_C4P';
const COORDINATOR_FOR_PEERS: AgentSpec = {
  ...COORDINATOR,
  description: COORDINATOR_PEER_SENTINEL_C4P,
} as AgentSpec;

describe('buildConversationalResult — sub-agent soul + skill loading', () => {
  test('Test 1: sub-agent loads its own soul (SoulStore precedence) and trace records its workerId', async () => {
    // Delegate dispatch sets `subInput.agentId = 'author'` and
    // `subInput.parentTaskId`. `intent.agentId` is unset (the recursion
    // guard demoted `agentic-workflow → conversational`, no LLM intent
    // was resolved). The persona priority chain must land on `author`,
    // SoulStore must override AgentSpec.soul, and the recorded trace's
    // workerId must reflect the resolved persona — otherwise the
    // dashboard mis-attributes the work.
    const capturedSystemPrompt: string[] = [];
    const workerIdSink: string[] = [];
    const deps = makeDeps({
      capturedSystemPrompt,
      workerIdSink,
      soulMap: { author: 'AUTHOR_SOUL_SENTINEL_X9K' },
    });
    await buildConversationalResult(
      makeInput({ agentId: asPersonaId('author'), parentTaskId: 'parent-1' }),
      intent(),
      deps,
    );
    expect(workerIdSink[0]).toBe('author');
    expect(capturedSystemPrompt[0]).toContain('AUTHOR_SOUL_SENTINEL_X9K');
    // SoulStore wins over the built-in AgentSpec.soul ("I write.").
    expect(capturedSystemPrompt[0]).not.toContain('I write.');
  });

  test('Test 2: sub-agent loads its own runtime skill cards via getDerivedCapabilities', async () => {
    // Worker-pool injects skill cards through the prompt-assembler
    // section; the conversational shortcircuit assembles by hand. Both
    // paths source from `agentRegistry.getDerivedCapabilities(id)`.
    // Sub-agent must see ITS OWN skills in the [LOADED SKILLS] block,
    // wrapped in the integrity-stamped <skill-card> envelope. Other
    // personas' skills must NOT bleed in.
    const capturedSystemPrompt: string[] = [];
    const workerIdSink: string[] = [];
    const researcherSkill = stubSkill({
      id: 'lit-review',
      whenToUse: 'RESEARCH_SKILL_SENTINEL_R7M',
    });
    const authorSkill = stubSkill({
      id: 'narrative-arc',
      whenToUse: 'AUTHOR_SKILL_SENTINEL_NEVER_VISIBLE',
    });
    const deps = makeDeps({
      capturedSystemPrompt,
      workerIdSink,
      roster: [COORDINATOR, RESEARCHER, AUTHOR],
      derivedMap: {
        researcher: {
          capabilities: [],
          effectiveAcl: {},
          loadedSkills: [researcherSkill],
          resolvedRefs: [],
          skipped: [],
        },
        author: {
          capabilities: [],
          effectiveAcl: {},
          loadedSkills: [authorSkill],
          resolvedRefs: [],
          skipped: [],
        },
      },
    });
    await buildConversationalResult(
      makeInput({ agentId: asPersonaId('researcher'), parentTaskId: 'parent-1' }),
      intent(),
      deps,
    );
    expect(capturedSystemPrompt[0]).toContain('[LOADED SKILLS]');
    expect(capturedSystemPrompt[0]).toContain('<skill-card source=');
    expect(capturedSystemPrompt[0]).toContain('RESEARCH_SKILL_SENTINEL_R7M');
    // Author's skill content must not appear in researcher's prompt.
    expect(capturedSystemPrompt[0]).not.toContain('AUTHOR_SKILL_SENTINEL_NEVER_VISIBLE');
  });

  test('Test 2b: missing getDerivedCapabilities (legacy registry) degrades gracefully — no [LOADED SKILLS] block, no crash', async () => {
    const capturedSystemPrompt: string[] = [];
    const workerIdSink: string[] = [];
    // No derivedMap → makeDeps does NOT attach getDerivedCapabilities.
    // The optional-chained guard must skip skill lookup entirely.
    const deps = makeDeps({ capturedSystemPrompt, workerIdSink });
    const outcome = await buildConversationalResult(
      makeInput({ agentId: asPersonaId('author'), parentTaskId: 'parent-1' }),
      intent(),
      deps,
    );
    expect(outcome.kind).toBe('final');
    expect(capturedSystemPrompt[0]).not.toContain('[LOADED SKILLS]');
  });
});

describe('buildConversationalResult — sub-task isolation', () => {
  test('Test 3: delegate sub-task suppresses [PEER AGENTS] roster and persona stays present', async () => {
    // Sub-tasks have no dispatch capability — listing peers is dead
    // context that historically invited the LLM to talk *about* the
    // other agents instead of producing its own step (session
    // a43487fd). The sub-task's own identity (mentor + soul) MUST stay.
    const capturedSystemPrompt: string[] = [];
    const workerIdSink: string[] = [];
    const deps = makeDeps({
      capturedSystemPrompt,
      workerIdSink,
      roster: [COORDINATOR_FOR_PEERS, AUTHOR, MENTOR, RESEARCHER],
    });
    await buildConversationalResult(
      makeInput({ agentId: asPersonaId('mentor'), parentTaskId: 'parent-1' }),
      intent(),
      deps,
    );
    const prompt = capturedSystemPrompt[0]!;
    // No peer block, no peer description leakage.
    expect(prompt).not.toContain('[PEER AGENTS');
    expect(prompt).not.toContain(COORDINATOR_PEER_SENTINEL_C4P);
    // Persona identity intact.
    expect(prompt).toContain('Mentor');
    expect(prompt).toContain('mentor');
    expect(prompt).toContain('I critique.');
    expect(workerIdSink[0]).toBe('mentor');
  });

  test('Test 4: sub-task suppresses session-turn history; standalone task still loads it', async () => {
    // `subInput.goal` already carries step description + parent goal +
    // dependency outputs + expectedOutput. The parent's session turn
    // history adds nothing new — it adds the parent's setup prose
    // ("have 3 agents debate competition design") which delegates then
    // echo. Suppression must apply only when `parentTaskId` is set,
    // never on standalone conversational turns.
    const capturedMessages: Array<HistoryMessage[] | undefined> = [];
    const sessionTurns = [{ role: 'user' as const, text: 'PARENT_PROSE_SENTINEL_P3X' }];

    // Sub-task pass: messages must be undefined.
    const subDeps = makeDeps({
      capturedSystemPrompt: [],
      workerIdSink: [],
      sessionTurns,
      capturedMessages,
    });
    await buildConversationalResult(
      makeInput({ agentId: asPersonaId('author'), parentTaskId: 'parent-1', sessionId: 'sess-1' }),
      intent(),
      subDeps,
    );
    expect(capturedMessages[0]).toBeUndefined();

    // Standalone pass: messages MUST be populated (regression guard).
    const standaloneDeps = makeDeps({
      capturedSystemPrompt: [],
      workerIdSink: [],
      sessionTurns,
      capturedMessages,
    });
    await buildConversationalResult(
      makeInput({ agentId: asPersonaId('author'), sessionId: 'sess-1' }),
      intent(),
      standaloneDeps,
    );
    expect(capturedMessages[1]).toBeDefined();
    expect(capturedMessages[1]?.[0]?.content).toContain('PARENT_PROSE_SENTINEL_P3X');
  });

  test('Test 5: [SUB-TASK CONTRACT] is present for sub-tasks and absent on standalone turns', async () => {
    // The contract is the only behavior-shaping line we add — it must
    // gate strictly on parentTaskId so non-sub-task conversational
    // turns are unaffected. Also pin the [ESCAPE PROTOCOL] mirror so a
    // future refactor cannot regress both at once.
    const subPrompts: string[] = [];
    const subDeps = makeDeps({ capturedSystemPrompt: subPrompts, workerIdSink: [] });
    await buildConversationalResult(
      makeInput({ agentId: asPersonaId('author'), parentTaskId: 'parent-1' }),
      intent(),
      subDeps,
    );
    expect(subPrompts[0]).toContain('[SUB-TASK CONTRACT]');
    expect(subPrompts[0]).toContain('Answer ONLY this assigned workflow step');
    expect(subPrompts[0]).toContain('Do not speak as or simulate other agents');
    // Escape protocol is suppressed for sub-tasks (existing carve-out).
    expect(subPrompts[0]).not.toContain('[ESCAPE PROTOCOL]');

    const standalonePrompts: string[] = [];
    const standaloneDeps = makeDeps({
      capturedSystemPrompt: standalonePrompts,
      workerIdSink: [],
    });
    await buildConversationalResult(makeInput({ agentId: asPersonaId('author') }), intent(), standaloneDeps);
    expect(standalonePrompts[0]).not.toContain('[SUB-TASK CONTRACT]');
    // Escape protocol present on standalone path (regression guard).
    expect(standalonePrompts[0]).toContain('[ESCAPE PROTOCOL]');
  });
});
