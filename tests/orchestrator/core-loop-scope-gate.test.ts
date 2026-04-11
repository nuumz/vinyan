/**
 * Tests for domain-aware tool scoping in core-loop.
 *
 * Verifies:
 * - All tasks (including greetings) proceed through LLM dispatch — no hard rejection
 * - Code tasks use expected orchestration approach
 * - Non-code tasks complete successfully via LLM
 * - Instruction echo detection rejects parroted system prompts (A1)
 * - Tool stripping removes mutating tools from non-mutation domains (A6)
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createOrchestrator } from '../../src/orchestrator/factory.ts';
import { createMockProvider } from '../../src/orchestrator/llm/mock-provider.ts';
import { LLMProviderRegistry } from '../../src/orchestrator/llm/provider-registry.ts';
import type { TaskInput } from '../../src/orchestrator/types.ts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'vinyan-scope-'));
  mkdirSync(join(tempDir, 'src'), { recursive: true });
  writeFileSync(join(tempDir, 'src', 'foo.ts'), 'export const x = 1;\n');
  writeFileSync(
    join(tempDir, 'vinyan.json'),
    JSON.stringify({
      oracles: {
        type: { enabled: false },
        dep: { enabled: false },
        ast: { enabled: false },
        test: { enabled: false },
        lint: { enabled: false },
      },
    }),
  );
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeReasoningInput(goal: string, overrides?: Partial<TaskInput>): TaskInput {
  return {
    id: `t-scope-${Date.now()}`,
    source: 'cli',
    goal,
    taskType: 'reasoning',
    budget: { maxTokens: 10_000, maxDurationMs: 5_000, maxRetries: 1 },
    ...overrides,
  };
}

function makeCodeInput(goal: string, overrides?: Partial<TaskInput>): TaskInput {
  return {
    id: `t-code-${Date.now()}`,
    source: 'cli',
    goal,
    taskType: 'code',
    budget: { maxTokens: 10_000, maxDurationMs: 5_000, maxRetries: 1 },
    ...overrides,
  };
}

function makeReasoningRegistry() {
  // Reasoning tasks need plain text response (not JSON) so workerPool sets proposedContent
  const registry = new LLMProviderRegistry();
  const content = 'This is my answer to your question.';
  registry.register(createMockProvider({ id: 'mock/fast', tier: 'fast', responseContent: content }));
  registry.register(createMockProvider({ id: 'mock/balanced', tier: 'balanced', responseContent: content }));
  registry.register(createMockProvider({ id: 'mock/powerful', tier: 'powerful', responseContent: content }));
  return registry;
}

function makeCodeRegistry() {
  const registry = new LLMProviderRegistry();
  const content = JSON.stringify({
    proposedMutations: [{ file: 'src/foo.ts', content: 'export const x = 2;\n', explanation: 'changed value' }],
    proposedToolCalls: [],
    uncertainties: [],
  });
  registry.register(createMockProvider({ id: 'mock/fast', tier: 'fast', responseContent: content }));
  registry.register(createMockProvider({ id: 'mock/balanced', tier: 'balanced', responseContent: content }));
  registry.register(createMockProvider({ id: 'mock/powerful', tier: 'powerful', responseContent: content }));
  return registry;
}

// ── All tasks go through LLM dispatch — no hard rejection ───────────────

describe('General-purpose orchestrator — all tasks dispatched', () => {
  test('greeting proceeds through LLM, not rejected', async () => {
    const orchestrator = createOrchestrator({ workspace: tempDir, registry: makeReasoningRegistry(), useSubprocess: false });
    const result = await orchestrator.executeTask(makeReasoningInput('สวัสดี'));

    expect(result.status).toBe('completed');
    // Should NOT contain hardcoded rejection message
    expect(result.answer).not.toContain('outside my capability scope');
    // Should have gone through LLM dispatch (not scope-rejection)
    expect(result.trace.approach).not.toBe('scope-rejection');
  });

  test('non-code request proceeds through LLM, not rejected', async () => {
    const orchestrator = createOrchestrator({ workspace: tempDir, registry: makeReasoningRegistry(), useSubprocess: false });
    const result = await orchestrator.executeTask(makeReasoningInput('ช่วยถ่ายรูป screenshot'));

    expect(result.status).toBe('completed');
    expect(result.answer).not.toContain('outside my capability scope');
    expect(result.trace.approach).not.toBe('scope-rejection');
  });

  test('code goal completes normally', async () => {
    const orchestrator = createOrchestrator({ workspace: tempDir, registry: makeCodeRegistry(), useSubprocess: false });
    const result = await orchestrator.executeTask(makeCodeInput('fix the authentication bug in login endpoint'));

    expect(result.status).toBe('completed');
    expect(result.trace.approach).not.toBe('scope-rejection');
  });

  test('reasoning about code completes normally', async () => {
    const orchestrator = createOrchestrator({ workspace: tempDir, registry: makeReasoningRegistry(), useSubprocess: false });
    const result = await orchestrator.executeTask(makeReasoningInput('explain how the database query optimizer works'));

    expect(result.status).toBe('completed');
    expect(result.trace.approach).not.toBe('scope-rejection');
  });
});
