/**
 * Multi-agent Phase 3 follow-up — verify specialist persona survives the
 * subprocess boundary.
 *
 * Before this landed, `OrchestratorTurnSchema` init had no agent fields, so
 * `agent-worker-entry.ts` built a generic "Vinyan autonomous agent" system
 * prompt regardless of which specialist was routed. This test proves that
 * when an init turn carries `agentProfile` + `soulContent` + `agentContext`,
 * the worker renders an "## Agent Identity" block at the TOP of the system
 * prompt and the LLM sees the specialist's soul.
 *
 * We exercise `runAgentWorkerLoop` directly via its injectable `WorkerIO`
 * seam — no child process spawn required. The mock LLM provider captures
 * the system prompt passed by the worker; we assert distinctive soul markers
 * appear.
 */
import { describe, expect, test } from 'bun:test';
import { runAgentWorkerLoop } from '../../src/orchestrator/agent/agent-worker-entry.ts';
import type { LLMProvider, LLMRequest, LLMResponse } from '../../src/orchestrator/types.ts';

interface CapturedCall {
  systemPrompt: string;
  messages: LLMRequest['messages'];
}

function makeCapturingProvider(response: Partial<LLMResponse> = {}): { provider: LLMProvider; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const provider: LLMProvider = {
    id: 'mock/capture',
    tier: 'fast',
    async generate(req: LLMRequest): Promise<LLMResponse> {
      // The agent-worker embeds the system prompt as messages[0].content.
      const systemMsg = req.messages?.[0];
      calls.push({
        systemPrompt: systemMsg && 'content' in systemMsg ? String(systemMsg.content) : '',
        messages: req.messages ?? [],
      });
      return {
        content: JSON.stringify({ status: 'done', summary: 'ok' }),
        model: 'mock/capture',
        toolCalls: [
          {
            id: 'tc-1',
            tool: 'attempt_completion',
            parameters: { status: 'done', summary: 'ok', proposedContent: 'ok' },
          },
        ],
        stopReason: 'tool_use',
        tokensUsed: { input: 100, output: 50 },
        ...response,
      };
    },
  };
  return { provider, calls };
}

/** Build a minimal init turn; overrides merge on top. */
function makeInitTurn(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'init',
    taskId: 'task-e2e',
    goal: 'Write a TS interface for User',
    taskType: 'code',
    routingLevel: 1,
    perception: {
      taskTarget: { file: 'src/user.ts', description: 'add user type' },
      dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
      diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
      verifiedFacts: [],
      runtime: { nodeVersion: 'v20', os: 'darwin', availableTools: [] },
    },
    workingMemory: {
      recentActions: [],
      failedApproaches: [],
      retryCount: 0,
      activeHypotheses: [],
      unresolvedUncertainties: [],
      scopedFacts: [],
    },
    budget: {
      maxTokens: 10_000,
      maxTurns: 3,
      maxDurationMs: 30_000,
      contextWindow: 100_000,
      base: 5_000,
      negotiable: 3_000,
      delegation: 2_000,
      maxExtensionRequests: 3,
      maxToolCallsPerTurn: 5,
      maxToolCalls: 10,
      delegationDepth: 0,
      maxDelegationDepth: 3,
    },
    allowedPaths: ['src/'],
    toolManifest: [],
    ...overrides,
  };
}

/** Drive runAgentWorkerLoop with an in-memory stdio pair. */
async function runLoop(provider: LLMProvider, initTurn: Record<string, unknown>): Promise<{ out: string[] }> {
  const inputQueue: (string | null)[] = [JSON.stringify(initTurn)];
  const out: string[] = [];
  const io = {
    async readLine(): Promise<string | null> {
      if (inputQueue.length === 0) return null;
      return inputQueue.shift()!;
    },
    writeLine(line: string) {
      out.push(line.trim());
    },
  };
  await runAgentWorkerLoop(provider, io);
  return { out };
}

describe('Multi-agent subprocess persona propagation', () => {
  test('baseline — init turn without agent fields produces generic system prompt (no Agent Identity block)', async () => {
    const { provider, calls } = makeCapturingProvider();
    await runLoop(provider, makeInitTurn());
    expect(calls.length).toBeGreaterThan(0);
    const prompt = calls[0]!.systemPrompt;
    expect(prompt).not.toContain('## Agent Identity');
    expect(prompt).toContain('Vinyan autonomous agent');
  });

  test('init turn with agentProfile prepends ## Agent Identity block', async () => {
    const { provider, calls } = makeCapturingProvider();
    await runLoop(
      provider,
      makeInitTurn({
        agentId: 'ts-coder',
        agentProfile: {
          id: 'ts-coder',
          name: 'TypeScript Coder',
          description: 'TypeScript/JavaScript specialist focused on type safety.',
          allowedTools: ['file_read', 'file_write', 'file_edit'],
          capabilityOverrides: { network: false, shell: false },
          routingHints: {
            preferDomains: ['code-mutation'],
            preferExtensions: ['.ts', '.tsx'],
          },
        },
      }),
    );
    const prompt = calls[0]!.systemPrompt;
    expect(prompt).toContain('## Agent Identity: TypeScript Coder (`ts-coder`)');
    expect(prompt).toContain('TypeScript/JavaScript specialist');
    expect(prompt).toContain('Allowed tools');
    expect(prompt).toContain('no network; no shell');
    // The identity block must precede the generic framing so it sets the
    // primary frame for the LLM.
    const identityIdx = prompt.indexOf('## Agent Identity:');
    const genericIdx = prompt.indexOf('Vinyan autonomous agent');
    expect(identityIdx).toBeGreaterThanOrEqual(0);
    expect(genericIdx).toBeGreaterThan(identityIdx);
  });

  test('soulContent is rendered verbatim in the Soul subsection', async () => {
    const soul = '# My Soul\n\nI am a careful reviewer who reads before editing — MARKER_PHRASE_XYZ.';
    const { provider, calls } = makeCapturingProvider();
    await runLoop(
      provider,
      makeInitTurn({
        agentId: 'ts-coder',
        agentProfile: {
          id: 'ts-coder',
          name: 'TypeScript Coder',
          description: 'TS specialist.',
        },
        soulContent: soul,
      }),
    );
    const prompt = calls[0]!.systemPrompt;
    expect(prompt).toContain('### Soul');
    expect(prompt).toContain('MARKER_PHRASE_XYZ');
  });

  test('agentContext strengths / weaknesses / lessons appear in prompt', async () => {
    const { provider, calls } = makeCapturingProvider();
    await runLoop(
      provider,
      makeInitTurn({
        agentId: 'ts-coder',
        agentProfile: {
          id: 'ts-coder',
          name: 'TypeScript Coder',
          description: 'TS specialist.',
        },
        agentContext: {
          identity: {
            agentId: 'ts-coder',
            persona: 'Careful TypeScript reviewer',
            strengths: ['SENTINEL_STRENGTH_A', 'SENTINEL_STRENGTH_B'],
            weaknesses: ['SENTINEL_WEAKNESS_X'],
            approachStyle: 'reads before editing',
          },
          memory: {
            episodes: [
              {
                taskId: 't-1',
                taskSignature: 'refactor::ts',
                outcome: 'success',
                lesson: 'SENTINEL_LESSON_ONE',
                filesInvolved: ['src/foo.ts'],
                approachUsed: 'extract method',
                timestamp: Date.now(),
              },
            ],
            lessonsSummary: 'SENTINEL_COMPILED_LESSONS',
          },
          skills: {
            proficiencies: {
              'refactor::ts': {
                taskSignature: 'refactor::ts',
                level: 'expert',
                successRate: 0.95,
                totalAttempts: 40,
                lastAttempt: Date.now(),
              },
            },
            preferredApproaches: {},
            antiPatterns: ['SENTINEL_ANTIPATTERN_NEVER'],
          },
          lastUpdated: Date.now(),
        },
      }),
    );
    const prompt = calls[0]!.systemPrompt;
    expect(prompt).toContain('Careful TypeScript reviewer');
    expect(prompt).toContain('SENTINEL_STRENGTH_A');
    expect(prompt).toContain('SENTINEL_STRENGTH_B');
    expect(prompt).toContain('SENTINEL_WEAKNESS_X');
    expect(prompt).toContain('reads before editing');
    expect(prompt).toContain('SENTINEL_COMPILED_LESSONS');
    expect(prompt).toContain('SENTINEL_LESSON_ONE');
    expect(prompt).toContain('SENTINEL_ANTIPATTERN_NEVER');
    expect(prompt).toContain('refactor::ts — expert');
  });
});
