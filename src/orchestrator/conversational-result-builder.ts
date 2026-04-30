/**
 * Conversational Result Builder — extracted intent-resolver short-circuit path.
 *
 * `buildConversationalResult()` runs when the IntentResolver chose
 * `strategy: 'conversational'`: a single LLM turn against the active
 * specialist persona, no tool loop, no oracle pipeline. This module also
 * owns the persona-aware system prompt assembly (escape protocol, peer
 * roster, soul lookup) and the escape-sentinel/hallucinated-delegation
 * detection that re-routes the task into the agentic-workflow strategy
 * when the persona signals (or fakes) delegation.
 *
 * Verbatim extraction from `core-loop.ts` to reduce file size; behavior,
 * trace shape, and event order are unchanged.
 */
import type { OrchestratorDeps } from './core-loop.ts';
import {
  renderSkillCard,
  type SkillCardView,
  toSkillCardView,
} from './agents/derive-persona-capabilities.ts';
import { buildShortCircuitProvenance } from './governance-provenance.ts';
import {
  detectHallucinatedDelegation,
  formatEscapeProtocolBlock,
  parseEscapeSentinel,
} from './intent/escape-sentinel.ts';
import {
  renderSimpleSkillSections,
  resolveSimpleSkillsForDispatch,
} from '../skills/simple/dispatch-helper.ts';
import type { SimpleSkill } from '../skills/simple/loader.ts';
import type { ExecutionTrace, IntentResolution, TaskInput, TaskResult } from './types.ts';

export type ConversationalOutcome =
  | { kind: 'final'; result: TaskResult }
  | { kind: 'reroute'; updatedIntent: IntentResolution; updatedInput: TaskInput };

export async function buildConversationalResult(
  input: TaskInput,
  intent: IntentResolution,
  deps: OrchestratorDeps,
): Promise<ConversationalOutcome> {
  const startTime = Date.now();
  const provider = deps.llmRegistry?.selectByTier('fast') ?? deps.llmRegistry?.selectByTier('balanced');
  const providerCount = deps.llmRegistry?.listProviders().length ?? 0;

  // A2: Honest "I don't know" — no provider available means no conversational answer possible.
  // Previous behavior echoed the goal back as the answer, which was dishonest.
  if (!provider && providerCount === 0) {
    const trace: ExecutionTrace = {
      id: `trace-${input.id}-no-provider`,
      taskId: input.id,
      workerId: 'kernel',
      timestamp: Date.now(),
      routingLevel: 0,
      approach: 'no-provider-escalation',
      oracleVerdicts: {},
      modelUsed: 'none',
      tokensConsumed: 0,
      durationMs: Math.max(1, Date.now() - startTime),
      outcome: 'escalated',
      failureReason: 'No LLM provider configured',
      affectedFiles: [],
      governanceProvenance: buildShortCircuitProvenance({
        input,
        decisionId: 'no-provider',
        attributedTo: 'intentResolver',
        wasGeneratedBy: 'buildConversationalResult',
        reason: 'No LLM provider configured for conversational response',
      }),
    };
    await deps.traceCollector.record(trace);
    deps.bus?.emit('trace:record', { trace });
    const result: TaskResult = {
      id: input.id,
      status: 'escalated',
      mutations: [],
      trace,
      answer: '',
      notes: ['No LLM provider configured — set OPENROUTER_API_KEY or ANTHROPIC_API_KEY'],
    };
    deps.bus?.emit('task:complete', { result });
    return { kind: 'final', result };
  }

  // Provider exists: attempt conversational generation. If generate throws (transient/auth error),
  // fall back to refinedGoal — this is a degraded-but-recoverable path, not a no-provider case.
  let answer = intent.refinedGoal;
  // Track real token consumption so the trace recorded below carries actual
  // values, not the hardcoded 0 that broke the dashboard's per-engine
  // averages (every conversational task previously contributed 0 tokens
  // and the column always showed "—").
  let tokensConsumed = 0;

  // Multi-agent: resolve the specialist persona for this turn so the
  // short-circuit reply matches the same identity that worker-pool would
  // inject in full-pipeline. Resolution priority:
  //   1. intent.agentId — explicit choice from the IntentResolver layer
  //   2. input.agentId  — set by the workflow executor when dispatching a
  //      delegate-sub-agent (e.g. resolvedAgentId='author'); without this
  //      delegated sub-tasks that fall through to the conversational
  //      short-circuit reverted to coordinator and lost the persona the
  //      planner had assigned (session a43487fd: author/mentor delegates
  //      proposed competition rules instead of answering, partly because
  //      the conversational path was speaking with the wrong soul).
  //   3. registry default — final fallback
  // Falls back to generic Vinyan when no registry is wired at all.
  const resolvedAgent = (() => {
    const reg = deps.agentRegistry;
    if (!reg) return undefined;
    const id = intent.agentId ?? input.agentId ?? reg.defaultAgent().id;
    return reg.getAgent(id) ?? reg.defaultAgent();
  })();
  // Persona runtime skill cards. Mirrors the worker-pool path
  // (`worker-pool.ts:744-750` and `worker-pool.ts:846-852`) so a delegate
  // sub-agent answering through the conversational shortcircuit sees the same
  // persona-bound skills its full-pipeline counterpart would. We deliberately
  // skip `extraRefs` (the skill-acquirer is async/IO and out of scope for the
  // synchronous conversational call). Optional-chained because narrow test
  // mocks omit `getDerivedCapabilities`; production registries always
  // implement it. Returns `null` when no skill resolver is wired — degrades
  // to no [LOADED SKILLS] block, never throws.
  let loadedSkillCards: SkillCardView[] | undefined;
  if (resolvedAgent && deps.agentRegistry?.getDerivedCapabilities) {
    try {
      const derived = deps.agentRegistry.getDerivedCapabilities(resolvedAgent.id);
      if (derived && derived.loadedSkills.length > 0) {
        loadedSkillCards = derived.loadedSkills.map(toSkillCardView);
      }
    } catch {
      /* registry without skill resolver — degrade silently */
    }
  }
  // Hybrid simple skills — match against the goal text using the same
  // resolver the worker-pool full-pipeline path uses, so a `/code-review`
  // explicit invocation or a description match works identically in both
  // paths. `skill:simple_invoked` fires here when bodies inline so factory
  // outcome telemetry records conversational invocations too. Per-agent
  // visibility is enforced by `getForAgent(agentId)` inside the helper.
  const { simpleSkills, simpleSkillBodies } = resolveSimpleSkillsForDispatch({
    registry: deps.simpleSkillRegistry,
    goal: input.goal,
    agentId: resolvedAgent?.id,
    matcherOpts: deps.simpleSkillMatcherOpts,
    bus: deps.bus,
    taskId: input.id,
  });
  const personaSystemPrompt = buildConversationalSystemPrompt(
    resolvedAgent,
    deps,
    input,
    loadedSkillCards,
    simpleSkills,
    simpleSkillBodies,
  );

  if (provider) {
    try {
      // A7: Load Turn-model history for multi-turn conversation continuity.
      // Flatten each Turn's text blocks into a single string for the
      // Anthropic HistoryMessage shape (tool_use is dropped here — this is
      // the conversational persona path, not the tool-loop path).
      let messages: import('./types.ts').HistoryMessage[] | undefined;
      // Sub-task carve-out: when this task is a delegated sub-agent
      // (`parentTaskId` set), do NOT load the parent session's turn history.
      // `subInput.goal` (built by `workflow-executor.ts:719-734`) already
      // carries everything the delegate needs — its step description, the
      // original user request, dependency outputs, and expected output.
      // Loading parent turns adds the parent's setup prose ("have 3 agents
      // debate competition design"), which delegates then echo back instead
      // of producing their own step deliverable (session a43487fd symptom).
      // Vinyan delegate sub-tasks are single-call (the executor dispatches
      // each via `executeTask(subInput)` once — no in-step multi-turn loop),
      // so suppressing turn history loses no required context. If a future
      // multi-turn-delegate feature lands, revisit this guard before flipping.
      if (input.sessionId && deps.sessionManager && !input.parentTaskId) {
        try {
          const mgr = deps.sessionManager as unknown as {
            getTurnsHistory?: (id: string, n?: number) => import('./types.ts').Turn[];
          };
          const turns = mgr.getTurnsHistory ? mgr.getTurnsHistory(input.sessionId, 20) : [];
          if (turns.length > 0) {
            messages = turns.map((t) => ({
              role: t.role,
              content: t.blocks
                .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
                .map((b) => b.text)
                .join('\n'),
            }));
          }
        } catch {
          /* non-fatal */
        }
      }
      const llmReq = {
        systemPrompt: personaSystemPrompt,
        userPrompt: input.goal,
        maxTokens: 2000,
        temperature: 0.3,
        messages,
      };
      const response =
        deps.streamingAssistantDelta && provider.generateStream
          ? await provider.generateStream(llmReq, ({ text }) => {
              if (!text) return;
              // `llm:stream_delta` is the canonical streaming event. The legacy
              // `agent:text_delta` mirror was removed — consumers (CLI, vinyan-ui,
              // VS Code panel) all listen to the richer shape now.
              deps.bus?.emit('llm:stream_delta', {
                taskId: input.id,
                kind: 'content',
                text,
              });
            })
          : await provider.generate(llmReq);
      answer = response.content;
      tokensConsumed = (response.tokensUsed?.input ?? 0) + (response.tokensUsed?.output ?? 0);
    } catch {
      answer = intent.refinedGoal;
    }
  }

  // Persona escape sentinel: the persona may have determined mid-generation
  // that this request needs proper agentic-workflow dispatch (e.g. a multi-
  // chapter creative deliverable that conversational cannot produce). Detect
  // the sentinel and re-route the task. Bound at one re-route per task via
  // `intentEscapeAttempts` — defensive belt-and-suspenders so a workflow
  // sub-task that bounces back to conversational cannot loop forever; the
  // second match falls through and the conversational answer is returned
  // as-is (degraded-but-safe).
  const escapeSignal = parseEscapeSentinel(answer);
  if (escapeSignal.matched && (input.intentEscapeAttempts ?? 0) < 1) {
    deps.bus?.emit('intent:escape_sentinel_fired', {
      taskId: input.id,
      persona: resolvedAgent?.id,
      reason: escapeSignal.reason ?? 'unspecified',
    });
    const seededWorkflowPrompt = `${escapeSignal.reason ?? 'persona escaped conversational shortcircuit'}\nOriginal user request: ${input.goal}`;
    const updatedIntent: IntentResolution = {
      ...intent,
      strategy: 'agentic-workflow',
      workflowPrompt: seededWorkflowPrompt,
      reasoningSource: 'persona-escape',
      reasoning: `${intent.reasoning ?? ''} [persona-escape: ${escapeSignal.reason ?? 'unspecified'}]`.trim(),
    };
    return {
      kind: 'reroute',
      updatedIntent,
      updatedInput: { ...input, intentEscapeAttempts: 1 },
    };
  }

  // Defense-in-depth: detect hallucinated delegation in the answer text when
  // the persona did NOT emit the escape sentinel. Smaller free-tier models
  // sometimes ignore the "do not promise to dispatch" rule and fabricate
  // delegation prose ("ขณะนี้โจทย์ถูกส่งไปยัง Developer และ Mentor"), leaving
  // the user with a fake acknowledgment and zero sub-tasks. When detected,
  // re-route as if the sentinel had fired so the work actually happens. Same
  // re-route budget as the sentinel path to prevent loops.
  if ((input.intentEscapeAttempts ?? 0) < 1) {
    const halluc = detectHallucinatedDelegation(answer);
    if (halluc.matched) {
      deps.bus?.emit('intent:hallucinated_delegation_detected', {
        taskId: input.id,
        persona: resolvedAgent?.id,
        snippet: halluc.snippet,
        locale: halluc.locale,
      });
      const seededWorkflowPrompt =
        `Persona claimed delegation in conversational mode without dispatch capability. Snippet: "${halluc.snippet}". ` +
        `Original user request: ${input.goal}`;
      const updatedIntent: IntentResolution = {
        ...intent,
        strategy: 'agentic-workflow',
        workflowPrompt: seededWorkflowPrompt,
        reasoningSource: 'persona-escape',
        reasoning:
          `${intent.reasoning ?? ''} [hallucinated-delegation: ${halluc.locale ?? 'unknown'}]`.trim(),
      };
      return {
        kind: 'reroute',
        updatedIntent,
        updatedInput: { ...input, intentEscapeAttempts: 1 },
      };
    }
  }

  const trace: ExecutionTrace = {
    id: `trace-${input.id}-conversational`,
    taskId: input.id,
    // Multi-agent: attribute the trace to the resolved persona (e.g. 'coordinator')
    // so context-builder/agent-evolution count this episode against the right agent.
    // Falls back to 'intent-resolver' for the legacy no-registry path.
    workerId: resolvedAgent?.id ?? 'intent-resolver',
    timestamp: Date.now(),
    routingLevel: 0,
    approach: 'conversational-shortcircuit',
    oracleVerdicts: {},
    modelUsed: provider?.id ?? 'none',
    tokensConsumed,
    durationMs: Math.max(1, Date.now() - startTime),
    outcome: 'success',
    affectedFiles: [],
    governanceProvenance: buildShortCircuitProvenance({
      input,
      decisionId: 'conversational-shortcircuit',
      attributedTo: 'intentResolver',
      wasGeneratedBy: 'buildConversationalResult',
      reason: intent.reasoning || 'Intent resolver selected conversational short-circuit',
      evidence: [
        {
          kind: 'routing-factor',
          source: 'intent-strategy',
          summary: `strategy=${intent.strategy}; confidence=${intent.confidence.toFixed(3)}`,
        },
      ],
    }),
  };
  await deps.traceCollector.record(trace);
  deps.bus?.emit('trace:record', { trace });
  const result: TaskResult = { id: input.id, status: 'completed', mutations: [], trace, answer };
  deps.bus?.emit('task:complete', { result });
  return { kind: 'final', result };
}

/**
 * Compose the conversational short-circuit system prompt with specialist
 * persona injection. Mirrors the persona/peer sections produced by
 * `assemblePrompt()` for the full pipeline so the same identity speaks in
 * both paths. When no agent registry is wired, returns the legacy generic
 * Vinyan prompt for backward compatibility.
 *
 * Soul lookup precedence: SoulStore (evolved/reflected) → AgentSpec.soul (built-in).
 */
function buildConversationalSystemPrompt(
  agent: import('./types.ts').AgentSpec | undefined,
  deps: OrchestratorDeps,
  input: TaskInput,
  loadedSkillCards: readonly SkillCardView[] | undefined,
  simpleSkills: readonly SimpleSkill[],
  simpleSkillBodies: readonly SimpleSkill[],
): string {
  const closing = `Respond naturally. Match the user's language. Maintain context across turns.
Never reveal your underlying model name or provider — you are Vinyan.
Do NOT use JSON or code blocks unless the user asks for code.
Do NOT narrate your reasoning process — just respond directly to the user.`;

  // Pre-render simple-skill blocks so both the no-agent and persona branches
  // emit them. Missing-or-empty blocks return null and are skipped silently.
  const simpleBlocks = renderSimpleSkillSections(simpleSkills, simpleSkillBodies);
  const appendSimpleBlocks = (parts: string[]): void => {
    if (simpleBlocks.available) {
      parts.push('');
      parts.push(simpleBlocks.available);
    }
    if (simpleBlocks.active) {
      parts.push('');
      parts.push(simpleBlocks.active);
    }
  };

  if (!agent) {
    const lines: string[] = [
      `You are Vinyan, a friendly and capable assistant. You can help with creative writing, analysis, Q&A, brainstorming, and general assistance.`,
    ];
    appendSimpleBlocks(lines);
    lines.push(closing);
    return lines.join('\n');
  }

  const lines: string[] = [];
  lines.push(`You are ${agent.name} (${agent.id}), a Vinyan specialist agent.`);
  lines.push(agent.description);

  // Soul: prefer disk-backed evolved soul (SoulReflector writes here), fall back to built-in.
  const evolvedSoul = deps.soulStore?.loadSoulRaw(agent.id) ?? null;
  const soul = evolvedSoul ?? agent.soul ?? null;
  if (soul) {
    lines.push('');
    lines.push('[AGENT SOUL]');
    lines.push(soul.trim());
  }

  // Persona runtime skill cards. Worker-pool injects these via the prompt
  // assembler's `agent-skill-cards` section — the conversational shortcircuit
  // assembles its prompt by hand, so we render the same cards inline.
  // `renderSkillCard` returns null when an envelope exceeds
  // MAX_SKILL_CARD_CHARS — we skip those (whole-block-or-skip per
  // `derive-persona-capabilities.ts:286-294`). If every card is oversize OR
  // the persona has no bound skills, we emit no header at all (no orphan
  // section).
  if (loadedSkillCards && loadedSkillCards.length > 0) {
    const rendered = loadedSkillCards
      .map((view) => renderSkillCard(view))
      .filter((card): card is string => card !== null);
    if (rendered.length > 0) {
      lines.push('');
      lines.push('[LOADED SKILLS]');
      for (const card of rendered) lines.push(card);
    }
  }

  // Peer roster: list other specialists so the persona can answer "what
  // can Vinyan do" honestly. NOTE: this conversational path has no dispatch
  // mechanism — the persona MUST NOT promise to "forward" or "hand off" to
  // peers from here. When a request actually needs another specialist to
  // PRODUCE a deliverable, the persona must emit the escape sentinel
  // documented in [ESCAPE PROTOCOL] below; the orchestrator then re-routes.
  //
  // Sub-task carve-out: when this task is a delegated sub-agent
  // (`parentTaskId` set), the persona is already inside the agentic-workflow
  // path AND has no dispatch capability — listing peers is dead context that
  // also invites the LLM to talk *about* the other agents instead of
  // producing its own step (session a43487fd: delegates described
  // "competition setup" instead of answering the assigned step). Mirrors the
  // escape-protocol sub-task carve-out further down — same predicate,
  // same reasoning.
  const peers = !input.parentTaskId
    ? (deps.agentRegistry?.listAgents() ?? []).filter((a) => a.id !== agent.id)
    : [];
  if (peers.length > 0) {
    lines.push('');
    lines.push('[PEER AGENTS — DO NOT PROMISE TO DISPATCH]');
    lines.push(
      'Vinyan has these specialist agents. You may MENTION their existence when describing capabilities, but you have NO ability to dispatch work to them from this turn. Do NOT say "I will forward this to X" — see [ESCAPE PROTOCOL] for the correct response when a request needs a specialist.',
    );
    lines.push(
      'For fiction/book/webtoon/story tasks the relevant specialists are creative; keep mentions within creative roles unless the user explicitly asks for software or system work.',
    );
    lines.push('Only describe listed agents as Vinyan agents; do not invent agent ids.');
    for (const p of peers) {
      lines.push(`  - ${p.id}: ${p.description}`);
    }
  }

  // Escape protocol: the persona's "I cannot answer this here" state. The
  // sentinel parser in `buildConversationalResult` detects emission and
  // re-routes the task into agentic-workflow (bounded at one re-route per
  // task via `TaskInput.intentEscapeAttempts`).
  //
  // Sub-task carve-out: when this task is itself a delegate-sub-agent
  // dispatched from a parent workflow (`parentTaskId` set), the persona is
  // already inside the agentic-workflow path — re-routing it would create
  // the recursion documented on `intent/strategy.ts:isSubTask`. Worse, the
  // free-tier author/researcher LLMs paraphrase the protocol stanza ("the
  // task is too big to handle inline, use a agentic-workflow path") and
  // then degenerate into a token loop ("topic-topic-topic-…"), which is
  // what we observed on the Step-2-of-4 author stream. Sub-tasks must
  // produce the step's deliverable directly; the parent synthesis step
  // takes care of the bigger picture.
  if (!input.parentTaskId) {
    lines.push('');
    lines.push(formatEscapeProtocolBlock());
  }

  // Sub-task contract — counterpart to the escape-protocol carve-out above.
  // Delegate sub-agents need an explicit reminder that they are answering
  // ONE workflow step, not designing the workflow or simulating peers. The
  // generic `closing` block (no JSON, no narrating reasoning) does not cover
  // these workflow-specific failure modes. The wording is deliberately
  // verbatim from the user spec — these are the exact failure modes seen
  // in session a43487fd (delegates echoing setup prose, asking the user
  // for a topic that prior step already produced, simulating other agents).
  if (input.parentTaskId) {
    lines.push('');
    lines.push('[SUB-TASK CONTRACT]');
    lines.push('Answer ONLY this assigned workflow step. Do not design the workflow.');
    lines.push('Do not ask the user for a topic if prior workflow output already contains one.');
    lines.push('Do not speak as or simulate other agents. Produce your deliverable directly.');
  }

  // Hybrid simple skills — descriptions (eager) and matched bodies (lazy).
  // Same content the prompt-section-registry renders for full-pipeline
  // workers, so a `/code-review` explicit invocation or a description match
  // works identically here. Empty blocks are skipped by the helper.
  appendSimpleBlocks(lines);

  lines.push('');
  lines.push(closing);
  return lines.join('\n');
}
