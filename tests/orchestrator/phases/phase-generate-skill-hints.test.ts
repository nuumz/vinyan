/**
 * Runtime skill hints in Generate phase.
 *
 * Verifies single-shot dispatch receives skill hints as execution context while
 * the caller's understanding object remains immutable.
 */
import { describe, expect, test } from 'bun:test';
import type { AgentMemoryAPI } from '../../../src/orchestrator/agent-memory/agent-memory-api.ts';
import type { WorkerPool } from '../../../src/orchestrator/core-loop.ts';
import { executeGeneratePhase } from '../../../src/orchestrator/phases/phase-generate.ts';
import type { PhaseContext } from '../../../src/orchestrator/phases/types.ts';
import type {
  CachedSkill,
  PerceptualHierarchy,
  RoutingDecision,
  SemanticTaskUnderstanding,
  TaskInput,
} from '../../../src/orchestrator/types.ts';
import { WorkingMemory } from '../../../src/orchestrator/working-memory.ts';

function makeInput(): TaskInput {
  return {
    id: 'generate-skill-hints',
    source: 'cli',
    goal: 'fix auth bug',
    taskType: 'code',
    targetFiles: ['src/auth.ts'],
    budget: { maxTokens: 10_000, maxRetries: 1, maxDurationMs: 30_000 },
  } as TaskInput;
}

function makePerception(): PerceptualHierarchy {
  return {
    taskTarget: { file: 'src/auth.ts', description: 'auth target' },
    dependencyCone: { directImporters: [], directImportees: [], transitiveBlastRadius: 0 },
    diagnostics: { lintWarnings: [], typeErrors: [], failingTests: [] },
    verifiedFacts: [],
    runtime: { availableTools: [] },
  } as unknown as PerceptualHierarchy;
}

function makeUnderstanding(): SemanticTaskUnderstanding {
  return {
    rawGoal: 'fix auth bug',
    actionVerb: 'fix',
    actionCategory: 'modification',
    frameworkContext: [],
    constraints: ['keep existing behavior'],
    acceptanceCriteria: [],
    expectsMutation: true,
    resolvedEntities: [],
    verifiedClaims: [],
    understandingDepth: 0,
    taskDomain: 'code',
    taskIntent: 'execute',
    toolRequirement: 'required',
    understandingFingerprint: 'u-1',
  } as unknown as SemanticTaskUnderstanding;
}

function makeSkill(overrides: Partial<CachedSkill> = {}): CachedSkill {
  return {
    taskSignature: 'fix::auth.ts',
    approach: 'use the existing auth helper',
    successRate: 0.88,
    status: 'active',
    probationRemaining: 0,
    usageCount: 7,
    riskAtCreation: 0.2,
    depConeHashes: {},
    lastVerifiedAt: Date.now(),
    verificationProfile: 'structural',
    ...overrides,
  };
}

function makeRouting(): RoutingDecision {
  return {
    level: 1,
    model: 'fast-test',
    budgetTokens: 10_000,
    latencyBudgetMs: 30_000,
  } as unknown as RoutingDecision;
}

describe('executeGeneratePhase runtime skill hints', () => {
  test('injects hints into single-shot dispatch without mutating original understanding', async () => {
    let capturedUnderstanding: SemanticTaskUnderstanding | undefined;
    const matchedSkill = makeSkill({ approach: 'matched exact approach', successRate: 0.93 });
    const agentMemory = {
      queryRelatedSkills: async () => [makeSkill({ taskSignature: 'similar::ts', approach: 'related memory approach' })],
    } as unknown as AgentMemoryAPI;
    const input = makeInput();
    const understanding = makeUnderstanding();
    const workerPool: WorkerPool = {
      getAgentLoopDeps: () => null,
      dispatch: async (_input, _perception, _memory, _plan, _routing, dispatchUnderstanding) => {
        capturedUnderstanding = dispatchUnderstanding;
        return { mutations: [], proposedToolCalls: [], tokensConsumed: 0, durationMs: 1 };
      },
    };
    const ctx: PhaseContext = {
      input,
      deps: {
        workerPool,
        agentMemory,
        skillHintsConfig: { enabled: true, topK: 1 },
      } as unknown as PhaseContext['deps'],
      startTime: Date.now(),
      workingMemory: new WorkingMemory(),
      explorationFlag: false,
    };

    const outcome = await executeGeneratePhase(ctx, {
      routing: makeRouting(),
      perception: makePerception(),
      understanding,
      plan: undefined,
      totalTokensConsumed: 0,
      budgetCapMultiplier: 6,
      matchedSkill,
      retry: 0,
    });

    expect(outcome.action).toBe('continue');
    expect(capturedUnderstanding?.constraints).toContain('keep existing behavior');
    expect(capturedUnderstanding?.constraints.some((c) => c.includes('[SKILL HINTS] 2 proven'))).toBe(true);
    expect(capturedUnderstanding?.constraints.some((c) => c.includes('matched exact approach'))).toBe(true);
    expect(capturedUnderstanding?.constraints.some((c) => c.includes('related memory approach'))).toBe(true);
    expect(understanding.constraints).toEqual(['keep existing behavior']);
  });
});
