/**
 * Workflow planner → executor dispatch — external-coding-cli strategy.
 *
 * Complements `workflow-dispatch.test.ts`. Where that file tests the
 * `CodingCliWorkflowStrategy.run()` adapter in isolation, this file tests
 * the executor → strategy dispatch path: a workflow plan that contains
 * an `external-coding-cli` step MUST flow through `deps.codingCliStrategy`
 * with the right inputs (providerId / mode / cwd / allowedScope).
 *
 * Tests:
 *   1. plan with one ECC step calls codingCliStrategy.run exactly once
 *      with providerId/mode/rootGoal pulled from step inputs/description.
 *   2. plan with one ECC step but missing strategy returns explicit
 *      "external-coding-cli strategy not wired" failure (NOT a crash).
 *   3. ownerType mapping: stage manifest todo for the ECC step is
 *      classified as `tool`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBus } from '../../../src/core/bus.ts';
import {
  CodingCliWorkflowStrategy,
  type CodingCliWorkflowOutcome,
  type CodingCliWorkflowStep,
} from '../../../src/orchestrator/external-coding-cli/external-coding-cli-workflow-strategy.ts';
import type { ExternalCodingCliController } from '../../../src/orchestrator/external-coding-cli/external-coding-cli-controller.ts';
import { createMockProvider } from '../../../src/orchestrator/llm/mock-provider.ts';
import { LLMProviderRegistry } from '../../../src/orchestrator/llm/provider-registry.ts';
import { executeWorkflow } from '../../../src/orchestrator/workflow/workflow-executor.ts';
import type { TaskInput } from '../../../src/orchestrator/types.ts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'vinyan-ecc-wf-'));
  mkdirSync(join(tempDir, 'src'), { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

class CapturingFakeStrategy extends CodingCliWorkflowStrategy {
  capturedSteps: CodingCliWorkflowStep[] = [];
  outcome: CodingCliWorkflowOutcome;
  constructor(outcome?: Partial<CodingCliWorkflowOutcome>) {
    super({} as ExternalCodingCliController);
    this.outcome = {
      status: 'completed',
      providerId: 'claude-code',
      capabilities: null,
      sessionId: 'fake',
      claim: {
        status: 'completed',
        summary: 'fake CLI run',
        changedFiles: ['src/foo.ts'],
        commandsRun: [],
        testsRun: [],
        decisions: [],
        verification: { claimedPassed: true, details: '' },
        blockers: [],
        requiresHumanReview: false,
      },
      verification: {
        passed: true,
        predictionError: false,
        actualPassed: true,
        details: 'fake verification',
        oracles: [],
      },
      reason: 'fake completed',
      ...outcome,
    } as CodingCliWorkflowOutcome;
  }
  override async run(step: CodingCliWorkflowStep): Promise<CodingCliWorkflowOutcome> {
    this.capturedSteps.push(step);
    return this.outcome;
  }
}

/**
 * Build an LLM registry whose balanced provider returns a workflow plan
 * containing exactly one external-coding-cli step. The synthesizer
 * provider is also stubbed so the workflow can wrap up.
 */
function makeRegistryReturningEccPlan() {
  const planResponse = JSON.stringify({
    goal: 'Refactor src/foo.ts using Claude Code',
    steps: [
      {
        id: 'step1',
        description: 'Refactor src/foo.ts to use functional style',
        strategy: 'external-coding-cli',
        dependencies: [],
        inputs: { providerId: 'claude-code', mode: 'headless' },
        expectedOutput: 'CLI claim with verification verdict',
        budgetFraction: 1.0,
      },
    ],
    synthesisPrompt: 'Return step1 result.',
  });
  const synthResponse = 'Refactor complete via Claude Code.';
  const registry = new LLMProviderRegistry();
  // Planner picks balanced first, then fast as fallback.
  registry.register(
    createMockProvider({ id: 'mock/balanced', tier: 'balanced', responseContent: planResponse }),
  );
  registry.register(
    createMockProvider({ id: 'mock/fast', tier: 'fast', responseContent: synthResponse }),
  );
  return registry;
}

function baseTaskInput(overrides: Partial<TaskInput> = {}): TaskInput {
  return {
    id: 'task-wf-ecc',
    source: 'cli',
    goal: 'Refactor src/foo.ts using Claude Code',
    taskType: 'feature',
    targetFiles: ['src/foo.ts'],
    constraints: [],
    budget: { maxTokens: 10_000, maxDurationMs: 60_000, maxRetries: 0 },
    ...overrides,
  } as TaskInput;
}

describe('workflow plan with one external-coding-cli step', () => {
  test('dispatches through codingCliStrategy.run with provider/mode from step.inputs', async () => {
    const fake = new CapturingFakeStrategy();
    const result = await executeWorkflow(baseTaskInput(), {
      bus: createBus(),
      llmRegistry: makeRegistryReturningEccPlan(),
      executeTask: async () =>
        ({ status: 'completed', answer: '', mutations: [], trace: { tokensConsumed: 0 } }) as never,
      codingCliStrategy: fake,
      workspace: tempDir,
    });

    expect(fake.capturedSteps.length).toBe(1);
    const step = fake.capturedSteps[0]!;
    expect(step.providerId).toBe('claude-code');
    expect(step.mode).toBe('headless');
    expect(step.rootGoal).toContain('Refactor src/foo.ts');
    // The executor's case 'external-coding-cli' uses input.targetFiles for
    // allowedScope when no per-step scope is provided.
    expect(step.allowedScope).toEqual(['src/foo.ts']);
    // Workflow result: completed (CLI claim + verification both passed).
    expect(result.status === 'completed' || result.status === 'partial').toBe(true);
  });

  test('without codingCliStrategy → step explicitly fails with "not wired" message', async () => {
    const result = await executeWorkflow(baseTaskInput(), {
      bus: createBus(),
      llmRegistry: makeRegistryReturningEccPlan(),
      executeTask: async () =>
        ({ status: 'completed', answer: '', mutations: [], trace: { tokensConsumed: 0 } }) as never,
      // Intentionally omit codingCliStrategy.
      workspace: tempDir,
    });

    // The step failed with a clear message; the workflow as a whole is
    // either failed or partial depending on synthesis behaviour. The key
    // assertion: the failure message names the missing dependency rather
    // than crashing or silently routing to shell_exec.
    const stepStr = JSON.stringify(result);
    expect(stepStr).toContain('external-coding-cli strategy not wired');
    expect(stepStr.toLowerCase()).not.toContain('dangerous metacharacter');
  });
});

describe('workflow plan stage-manifest', () => {
  test('external-coding-cli step is marked ownerType=tool in todo manifest', async () => {
    const fake = new CapturingFakeStrategy();
    const bus = createBus();
    const todoEvents: unknown[] = [];
    bus.on('workflow:todo_created', (payload) => todoEvents.push(payload));

    await executeWorkflow(baseTaskInput(), {
      bus,
      llmRegistry: makeRegistryReturningEccPlan(),
      executeTask: async () =>
        ({ status: 'completed', answer: '', mutations: [], trace: { tokensConsumed: 0 } }) as never,
      codingCliStrategy: fake,
      workspace: tempDir,
    });

    expect(todoEvents.length).toBeGreaterThan(0);
    const eventStr = JSON.stringify(todoEvents);
    // External-coding-cli step → ownerType: 'tool' (not 'agent', not 'human').
    expect(eventStr).toContain('"ownerType":"tool"');
  });
});

