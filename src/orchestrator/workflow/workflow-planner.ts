/**
 * Workflow Planner — LLM-powered multi-step workflow generation.
 *
 * Given a high-level goal + knowledge context, produces a WorkflowPlan
 * (DAG of typed steps) that the Workflow Executor dispatches. Falls back
 * to a single llm-reasoning step if the LLM fails or returns invalid JSON.
 *
 * A1: the planner generates candidates; the Zod schema validates structure.
 * A3: fallback to single-step is deterministic.
 */
import type { VinyanBus } from '../../core/bus.ts';
// (used by sanitizeDelegateAgentIds / formatAgentRoster — keep import even
// if the only consumer above is implicit)
import { frozenSystemTier } from '../llm/prompt-assembler.ts';
import type { LLMProviderRegistry } from '../llm/provider-registry.ts';
import type { Turn } from '../types.ts';
import type { AgentRegistry } from '../agents/registry.ts';
import { buildKnowledgeContext, type KnowledgeContextDeps } from './knowledge-context.ts';
import { normalizeWorkflowPlan } from './plan-normalizer.ts';
import { formatSessionTranscript } from './session-transcript.ts';
import { type WorkflowPlan, WorkflowPlanSchema } from './types.ts';

export interface WorkflowPlannerDeps {
  llmRegistry?: LLMProviderRegistry;
  knowledgeDeps: KnowledgeContextDeps;
  bus?: VinyanBus;
  /**
   * Optional roster source. When supplied, the planner emits the registered
   * agent IDs + descriptions into its user prompt so the LLM can assign
   * `delegate-sub-agent` steps to specific personas (e.g. "have developer
   * answer step1, architect answer step2"). Without this the planner has no
   * idea which agent IDs are valid and falls back to leaving `agentId`
   * unset, which routes every delegate to the default coordinator.
   */
  agentRegistry?: AgentRegistry;
}

export interface PlannerOptions {
  goal: string;
  /**
   * Identity of the task this plan is being created for. Threaded into the
   * `workflow:plan_created` audit event so `TaskEventRecorder` can persist
   * the row keyed by `task_id` (without it the recorder drops the event at
   * its `!ids.taskId` guard).
   */
  taskId: string;
  /**
   * Optional session id. When set, lands on `task_events.session_id` directly
   * so historical replay can scope the planner-output row by session without
   * waiting for the recorder's session-cache backfill from a downstream event.
   */
  sessionId?: string;
  targetFiles?: string[];
  taskSignature?: string;
  constraints?: string[];
  acceptanceCriteria?: string[];
  intentWorkflowPrompt?: string;
  /**
   * Recent session turns (oldest → newest) so the planner can produce a plan
   * that continues / extends prior assistant output rather than restarting
   * from scratch on follow-up turns ("write chapter 2", "refine that"). When
   * empty or omitted the planner sees the goal alone — same as the original
   * single-turn behaviour.
   */
  sessionTurns?: Turn[];
}

const SYSTEM_PROMPT = `You are a workflow planner for the Vinyan autonomous agent orchestrator.

Given a high-level goal and optional context, produce a multi-step workflow as JSON.

Output ONLY valid JSON matching this schema:
{
  "goal": "string — the original goal",
  "steps": [
    {
      "id": "step1",
      "description": "what this step does (human-readable)",
      "command": "OPTIONAL — required when strategy='direct-tool'; the exact shell command to execute (e.g. 'ls -la ~/Desktop'). Omit for non-direct-tool steps.",
      "strategy": "full-pipeline | direct-tool | knowledge-query | llm-reasoning | delegate-sub-agent | human-input | external-coding-cli",
      "agentId": "OPTIONAL — required when strategy='delegate-sub-agent' AND the goal asks for a specific persona / multi-agent diversity; the exact agent id from the [AVAILABLE AGENTS] roster (e.g. 'developer', 'architect'). Omit for non-delegate steps or when any persona will do.",
      "dependencies": ["step IDs this depends on"],
      "inputs": { "key": "$stepN.result — reference to a prior step's output" },
      "expectedOutput": "what this step should produce",
      "budgetFraction": 0.2
    }
  ],
  "synthesisPrompt": "how to combine step results into a final answer"
}

Strategy selection rules:
- "full-pipeline": code changes requiring file edits + oracle verification
- "direct-tool": single shell command or file read — INCLUDING filesystem inspection (ls/find/cat single file/grep), checking running processes (ps/lsof), and any goal asking to inspect, list, read, or run something on the user's machine. When the goal asks for filesystem/shell information, the workflow MUST start with a \`direct-tool\` step that produces the actual data; a subsequent \`llm-reasoning\` step can analyze that output.
- "knowledge-query": lookup facts, prior approaches, or codebase structure
- "llm-reasoning": analysis, summarization, decision-making (no side effects). Do NOT use this when the user asked for filesystem/shell data — the LLM cannot see the user's machine; pair it with a \`direct-tool\` step first.
- "delegate-sub-agent": complex sub-tasks that need their own planning cycle
- "human-input": when you genuinely cannot proceed without user clarification
- "external-coding-cli": delegate the *whole* coding task to an external coding-CLI agent (Claude Code, GitHub Copilot CLI). Use this when the user explicitly asks Vinyan to drive an external CLI ("สั่งงาน claude code", "ask Claude Code to ...", "use copilot cli to ...") OR when prior turns established that Vinyan is operating on behalf of an external CLI delegation and the current step continues that delegation. The executor spawns the CLI, captures hook events, and runs Vinyan's verifier on the CLI's claim — you do NOT need to write the CLI invocation yourself; just produce ONE step with strategy='external-coding-cli' and put the CLI's task in \`description\`. Inputs MAY include \`{ "providerId": "claude-code" | "github-copilot", "mode": "headless" | "interactive" }\` to override the controller's default routing.

When the goal is structurally a CLI delegation, do NOT decompose it into 5+ \`llm-reasoning\` steps that *describe* running CLI commands — that produces a plan the LLM hallucinates through. Emit ONE \`external-coding-cli\` step (with an optional preceding \`direct-tool\` ls/cat to validate input paths, and an optional trailing \`llm-reasoning\` step to summarize the CLI's verification report).

Worked examples for filesystem / shell goals:
- Goal: "list files in ~/Desktop" / "ตรวจสอบไฟล์ ~/Desktop/" → step1 strategy='direct-tool', description='List files in ~/Desktop', command='ls -la ~/Desktop'; step2 strategy='llm-reasoning' if the user wants analysis on top of the listing.
- Goal: "show contents of src/foo.ts" / "ดู src/foo.ts" → step1 strategy='direct-tool', description='Show contents of src/foo.ts', command='cat src/foo.ts'.
- Goal: "ตรวจสอบว่า npm test ผ่านมั้ย" → step1 strategy='direct-tool', description='Run npm test', command='npm test'.
- For \`direct-tool\` steps the \`command\` field MUST be a runnable shell command, never a natural-language sentence. \`description\` may be human-readable.
- Never invent the contents of a file/directory in \`llm-reasoning\`; always read it first via \`direct-tool\`.

Worked examples for external coding-CLI delegation:
- Goal: "สั่งงาน claude code cli ช่วยรัน verify flow ใน /path/to/spec" → step1 strategy='direct-tool', command='ls -la /path/to/spec' (sanity check the path); step2 strategy='external-coding-cli', description='Verify the open-account flow against the design spec at /path/to/spec', inputs={"providerId": "claude-code", "mode": "headless"}; step3 strategy='llm-reasoning' depending on step2, description='Summarize the CLI verification report'.
- Goal: "ask claude code to refactor src/foo.ts" → ONE step with strategy='external-coding-cli', description='Refactor src/foo.ts (pass clear acceptance criteria from the goal)', inputs={"providerId": "claude-code"}.
- Goal: "use github copilot cli to scaffold a TypeScript project" → ONE step with strategy='external-coding-cli', description='Scaffold a TypeScript project per the user request', inputs={"providerId": "github-copilot"}.
- ANTI-PATTERN — do NOT do this: "Generate and execute claude-code CLI commands to verify X" / "Generate and execute claude-code CLI commands to verify Y" / "Generate and execute claude-code CLI commands to verify Z" / ... as four \`llm-reasoning\` steps. The LLM cannot run the CLI from inside an llm-reasoning step. Use ONE \`external-coding-cli\` step and let the controller drive the CLI.

Creative writing rules:
- For novel, fiction, book, webtoon, story, plot, chapter, or prose work, "write" means author creative text, not write code.
- Internal creative roles are routing hints, not user-facing instructions. Step descriptions should describe the work (brief, plot options, structure, draft prose, edit, critique) rather than telling the user to contact or wait for a named internal role.
- If the plan delegates internally, the final synthesis must present the result or the necessary clarification questions to the user; do not leak handoff mechanics.
- Do NOT use developer, architect, reviewer, full-pipeline, direct-tool, code mutation, tests, or implementation steps unless the user explicitly asks for software/code.

Multi-agent rules (FALLBACK PATH — when the user asks for "N agents" / "have agents debate/compete/collaborate" / "แบ่ง agent N ตัว"):
NOTE: prompts that carry a structured count ARE intercepted upstream by the
deterministic CollaborationDirective parser (intent/collaboration-parser.ts)
and routed through the persistent-participant collaboration runner
(workflow/collaboration-runner.ts). The rules below ONLY fire for prompts
that match the multi-agent regex but carry NO extractable count (e.g.
"have agents debate" with no number). Do NOT remove these rules under
the assumption they are dead code — they are the planner's fallback for
the no-count branch. The runner-vs-planner boundary is enforced in
core-loop.ts; if you tighten the parser to catch more shapes, this
fallback shrinks proportionally but should remain.
- Produce N \`delegate-sub-agent\` steps, ONE per requested persona.
- EACH delegate step MUST set \`agentId\` to a distinct id from the [AVAILABLE AGENTS] roster shown below — DO NOT invent ids and DO NOT reuse the same id across multiple steps in the same multi-agent plan.
- If the user asks for a specific persona ("ให้ developer ตอบ", "have the architect answer"), match that persona name to the closest \`agentId\` in the roster.
- If the user only specifies a count ("3 agents") without naming personas, pick N agents from the roster whose roles are diverse enough to make the comparison meaningful (e.g. one Generator, one Verifier, one Guide rather than three Generators).
- A single \`llm-reasoning\` step that internally role-plays "Agent A says X, Agent B says Y" is FORBIDDEN for multi-agent goals — that produces fake diversity from one model. Use \`delegate-sub-agent\` so each persona actually runs in its own sub-task.
- step.description for a delegate-sub-agent step MUST describe ONLY the task to perform (the question to answer / the artifact to produce). It MUST NOT prescribe HOW the agent should answer — no "focusing on X", "provide a deep/creative/structured answer", "with style Y", "from the perspective of Y emphasizing Z". The agent's own persona (its soul) already encodes how. Adding stylistic hints to the description duplicates the soul, conflicts with it, and collapses the very diversity the user asked for — different personas read the same prescriptive description and converge on a shared template.
  - Good: "Answer the question: <question text>"
  - Good: "Respond to step1.result"
  - Bad:  "Provide a deep, evidence-based answer focusing on factual synthesis"
  - Bad:  "Craft a creative narrative emphasizing storytelling and engagement"
  - Bad:  "Provide a guided answer focusing on the 'how' and 'why'"
- Add a final \`llm-reasoning\` synthesis step (depends on all delegate steps) that combines the distinct agent outputs into the comparison/debate the user asked for.
- For COMPETITION goals (the user explicitly asked to pick a winner / rank / compete: "แข่ง", "winner", "best of", "vote", "compete"), the synthesisPrompt MUST end with this exact instruction so the executor can extract a structured verdict:
  > After your free-text answer, end the response with a fenced JSON block matching:
  > \`\`\`json
  > { "winner": "<agentId from the participating set, or null for a deliberate tie>", "reasoning": "one-sentence rationale", "scores": { "<agentId>": 0-10 integer, ... } }
  > \`\`\`
  > Do NOT replace the free-text answer with the JSON; both must be present, free-text first.
  Use the integer 0-10 scale for scores (higher = better) and only include agentIds that actually participated. The JSON block is REQUIRED for COMPETITION goals; non-competition multi-agent (debate / comparison / parallel work) does NOT need it.

Guidelines:
- Start with a knowledge-query step to gather context when the goal is broad
- Use llm-reasoning for synthesis and analysis steps
- Use full-pipeline only for actual code mutations
- Keep step count between 2-6 for most goals
- Budget fractions must sum to ≤ 1.0
- Each step ID must be unique (step1, step2, etc.)
- Dependencies form a DAG — no cycles`;

export async function planWorkflow(deps: WorkflowPlannerDeps, opts: PlannerOptions): Promise<WorkflowPlan> {
  // Single emit site for `workflow:plan_created`. Every exit path of this
  // function flows through `finalize()` so the audit row is recorded for both
  // the LLM-success path (origin='llm') and the deterministic fallback path
  // (origin='fallback', no provider OR both LLM attempts failed). Keeping
  // emit centralized prevents the retry loop from double-emitting on its
  // second iteration if the structure is later edited.
  const finalize = (plan: WorkflowPlan, origin: 'llm' | 'fallback', attempts: number): WorkflowPlan => {
    deps.bus?.emit('workflow:plan_created', {
      taskId: opts.taskId,
      sessionId: opts.sessionId,
      goal: opts.goal,
      origin,
      attempts,
      steps: plan.steps.map((s) => ({
        id: s.id,
        description: s.description,
        strategy: s.strategy,
        dependencies: s.dependencies ?? [],
      })),
    });
    return plan;
  };

  const provider = deps.llmRegistry?.selectByTier('balanced') ?? deps.llmRegistry?.selectByTier('fast');
  if (!provider) return finalize(fallbackPlan(opts.goal), 'fallback', 0);

  const knowledgeContext = await buildKnowledgeContext(deps.knowledgeDeps, {
    targetFiles: opts.targetFiles,
    taskSignature: opts.taskSignature,
  });

  let userPrompt = `Goal: ${opts.goal}`;
  // Prior conversation block — placed BEFORE intent analysis / constraints so
  // the planner reads it as the framing for the goal rather than a footnote.
  // The transcript helper caps length aggressively to keep the planner's
  // input budget intact.
  const transcript = formatSessionTranscript(opts.sessionTurns);
  if (transcript) {
    userPrompt +=
      '\n\nPrior conversation in this session (oldest → newest). The current ' +
      'goal above continues from these turns; design the plan to extend or ' +
      'build on prior assistant output rather than restarting from scratch:\n' +
      transcript;
  }
  if (opts.intentWorkflowPrompt) {
    userPrompt += `\n\nIntent analysis: ${opts.intentWorkflowPrompt}`;
  }
  if (opts.targetFiles?.length) {
    userPrompt += `\nTarget files: ${opts.targetFiles.join(', ')}`;
  }
  if (opts.constraints?.length) {
    // Strip orchestrator-internal prefixes — workflow planner should only see
    // user intent, not JSON payloads from other pipeline stages.
    const { userConstraintsOnly } = await import('../constraints/pipeline-constraints.ts');
    const userCs = userConstraintsOnly(opts.constraints);
    if (userCs.length > 0) {
      userPrompt += `\n\nConstraints:\n${userCs.map((c) => `- ${c}`).join('\n')}`;
    }
  }
  if (opts.acceptanceCriteria?.length) {
    userPrompt += `\n\nAcceptance criteria:\n${opts.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}`;
  }
  if (knowledgeContext) {
    userPrompt += `\n\nKnowledge context (from Vinyan's memory):\n${knowledgeContext}`;
  }

  // Roster of agent personas the planner can target via `delegate-sub-agent`.
  // Required for multi-agent goals — without it the planner does not know
  // which `agentId` values are valid and the resulting plan either omits
  // agentId (everything routes to coordinator) or invents non-existent ids
  // (delegate fails). Capped to keep the planner prompt budget tidy.
  if (deps.agentRegistry) {
    const roster = formatAgentRoster(deps.agentRegistry);
    if (roster) {
      userPrompt += `\n\n[AVAILABLE AGENTS] (use these ids verbatim in step.agentId for delegate-sub-agent steps):\n${roster}`;
    }
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await provider.generate({
        systemPrompt: SYSTEM_PROMPT,
        userPrompt,
        maxTokens: 4000,
        // Mark the SYSTEM_PROMPT (large + constant across every workflow
        // invocation) as the frozen tier so Anthropic-direct providers cache
        // it for 1h. The user prompt is fully turn-volatile (goal + session
        // transcript + knowledge context) — no cache markers there. OpenRouter
        // and the test mocks ignore `tiers` silently, so this is safe.
        tiers: frozenSystemTier(SYSTEM_PROMPT, userPrompt),
      });

      const cleaned = response.content
        .trim()
        .replace(/^```(?:json)?\s*/i, '')
        .replace(/\s*```$/i, '');
      const parsed = JSON.parse(cleaned);
      const rawPlan = WorkflowPlanSchema.parse(parsed);
      // Sanitize delegate agentIds: drop hallucinated ids (not in registry)
      // and de-duplicate within the same plan. Both failure modes silently
      // collapse persona diversity — a hallucinated id falls back to the
      // default coordinator soul (sub-agent answers in coordinator voice
      // instead of the requested specialist), and a duplicated id runs the
      // same persona twice in parallel (the user gets two near-identical
      // answers presented as if they were distinct voices). Sanitization
      // strips the offending agentId so the executor uses default routing
      // — the planner's intent to delegate is preserved, but the delegate
      // is honestly anonymous rather than misattributed.
      const sanitized = sanitizeDelegateAgentIds(rawPlan, deps.agentRegistry, deps.bus);
      // Q1+Q2 — deterministic post-parse normalization. Fills in the
      // step-level retry budget and the auto-fallback strategy for
      // single delegate-sub-agent plans. Pure function; runs before
      // the plan is handed to the executor so what gets persisted is
      // exactly what the executor will dispatch.
      const plan = normalizeWorkflowPlan(sanitized);
      return finalize(plan, 'llm', attempt + 1);
    } catch {
      // retry once
    }
  }

  return finalize(fallbackPlan(opts.goal), 'fallback', 2);
}

/**
 * Validate and clean up `step.agentId` on `delegate-sub-agent` steps.
 *
 * Two failure modes the LLM planner produces in practice:
 *
 * 1. **Hallucinated id** — planner writes an `agentId` that doesn't exist
 *    in the registry (e.g. `'developer-agent'` when only `'developer'` is
 *    registered, or invents `'philosopher'` for a persona we don't have).
 *    Without sanitization, the executor's `verifierAgentId ?? step.agentId`
 *    chain still tries the bad id and falls through to the default
 *    coordinator — but the delegate's output is then attributed to the
 *    PLANNER'S intended persona, not the actual coordinator who ran it.
 *    Silent persona misattribution.
 *
 * 2. **Duplicate id within the same plan** — planner assigns the same
 *    persona to multiple `delegate-sub-agent` steps (e.g. two steps with
 *    `agentId='researcher'`). The two parallel sub-tasks run the same
 *    persona with the same step description, producing near-identical
 *    answers presented in the UI as if they were distinct voices.
 *    Fake diversity.
 *
 * Sanitization drops the offending agentId rather than dropping the whole
 * step — the executor will fall back to default routing, and the
 * UI/trace shows the delegate as `agent?` (the AgentTimelineCard's
 * fallback label) rather than misattributing the answer.
 *
 * Pure: no I/O. Emits a single observability event when corrections are
 * applied so production can detect when planner output deviates.
 */
function sanitizeDelegateAgentIds(
  plan: WorkflowPlan,
  registry: AgentRegistry | undefined,
  bus?: VinyanBus,
): WorkflowPlan {
  // Build the registry id set once. When no registry is wired, we cannot
  // verify ids — pass through (legacy / minimal test setups).
  const knownIds = new Set<string>();
  if (registry) {
    try {
      for (const a of registry.listAgents()) knownIds.add(a.id);
    } catch {
      return plan;
    }
  }

  const seenAgentIds = new Set<string>();
  const droppedHallucinated: Array<{ stepId: string; agentId: string }> = [];
  const droppedDuplicate: Array<{ stepId: string; agentId: string }> = [];

  const steps = plan.steps.map((s) => {
    if (s.strategy !== 'delegate-sub-agent' || !s.agentId) return s;
    const id = s.agentId;
    // Hallucinated: not in registry. Skip when registry was unavailable
    // (knownIds is empty AND registry was undefined).
    if (registry && !knownIds.has(id)) {
      droppedHallucinated.push({ stepId: s.id, agentId: id });
      const { agentId: _drop, ...rest } = s;
      return rest;
    }
    // Duplicate within plan.
    if (seenAgentIds.has(id)) {
      droppedDuplicate.push({ stepId: s.id, agentId: id });
      const { agentId: _drop, ...rest } = s;
      return rest;
    }
    seenAgentIds.add(id);
    return s;
  });

  if (droppedHallucinated.length > 0 || droppedDuplicate.length > 0) {
    bus?.emit('workflow:planner_validation_warning', {
      goal: plan.goal,
      hallucinatedAgentIds: droppedHallucinated,
      duplicateAgentIds: droppedDuplicate,
    });
  }

  return { ...plan, steps };
}

/**
 * Render the agent registry as a compact roster the planner LLM can read.
 * Bullet list of `id — description` lines, capped at 12 agents to keep the
 * prompt budget bounded (typical roster is ~9 personas).
 */
function formatAgentRoster(registry: AgentRegistry): string {
  let agents: ReadonlyArray<{ id: string; description?: string }>;
  try {
    agents = registry.listAgents();
  } catch {
    return '';
  }
  if (!agents || agents.length === 0) return '';
  const MAX_AGENTS = 12;
  const lines = agents
    .slice(0, MAX_AGENTS)
    .map((a) => `  - ${a.id}: ${a.description ?? '(no description)'}`);
  return lines.join('\n');
}

function fallbackPlan(goal: string): WorkflowPlan {
  // Run through the normalizer for consistency — it's a no-op on this
  // shape (single llm-reasoning step), but funnelling every plan through
  // the same gate means the executor never sees an unnormalized plan.
  return normalizeWorkflowPlan({
    goal,
    steps: [
      {
        id: 'step1',
        description: goal,
        strategy: 'llm-reasoning',
        dependencies: [],
        inputs: {},
        expectedOutput: 'Direct response to the goal',
        budgetFraction: 1.0,
      },
    ],
    synthesisPrompt: 'Return the result of step1 directly.',
  });
}
