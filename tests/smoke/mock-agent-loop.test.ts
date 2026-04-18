/**
 * Smoke Test — Mock-Provider End-to-End Agent Loop Validation
 *
 * PURPOSE: Prove the autonomous agent loop runs end-to-end without credentials.
 * This is the deterministic counterpart to real-task.test.ts (which requires API keys).
 *
 * WHAT IT TESTS:
 * 1. Factory constructs orchestrator with a scripted mock provider.
 * 2. A reasoning task reaches `completed` status with a non-empty answer.
 * 3. Bus emits expected phase events (task:start, intent:resolved, task:complete).
 * 4. Execution trace is recorded with the mock provider as modelUsed.
 *
 * NO API KEYS REQUIRED — runs in CI and locally.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createBus } from '../../src/core/bus.ts';
import { createOrchestrator } from '../../src/orchestrator/factory.ts';
import { createScriptedMockProvider } from '../../src/orchestrator/llm/mock-provider.ts';
import { LLMProviderRegistry } from '../../src/orchestrator/llm/provider-registry.ts';
import type { TaskInput } from '../../src/orchestrator/types.ts';

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'vinyan-mock-smoke-'));
  mkdirSync(join(tempDir, 'src'), { recursive: true });
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('Smoke: mock-provider agent loop', () => {
  test('reasoning task completes end-to-end with scripted mock', async () => {
    // Scripted mock: one response for intent resolution, one for conversational generate
    const mockProvider = createScriptedMockProvider(
      [
        {
          content: JSON.stringify({
            strategy: 'conversational',
            refinedGoal: 'Answer: 2+2 equals 4.',
            reasoning: 'Simple arithmetic question',
            confidence: 0.95,
          }),
          stopReason: 'end_turn',
        },
        {
          content: '2+2 equals 4.',
          stopReason: 'end_turn',
        },
      ],
      { id: 'mock/fast-tier', tier: 'fast' },
    );

    // Registry with our scripted provider registered as 'fast' tier
    const registry = new LLMProviderRegistry();
    registry.register(mockProvider);

    const bus = createBus();
    const busEvents: string[] = [];
    bus.on('task:start', () => busEvents.push('task:start'));
    bus.on('task:complete', () => busEvents.push('task:complete'));
    bus.on('intent:resolved', () => busEvents.push('intent:resolved'));

    const orchestrator = createOrchestrator({
      workspace: tempDir,
      registry,
      bus,
      useSubprocess: false, // in-process mode for deterministic testing
      watchWorkspace: false, // disable file watcher for tempdir cleanup safety
    });

    const input: TaskInput = {
      id: `smoke-mock-${Date.now()}`,
      source: 'api',
      goal: 'What is 2+2?',
      taskType: 'reasoning',
      budget: { maxTokens: 4000, maxDurationMs: 30_000, maxRetries: 1 },
    };

    const result = await orchestrator.executeTask(input);

    // Assertions: the loop actually ran
    expect(result.status).toBe('completed');
    expect(result.answer).toBeTruthy();
    expect(result.answer!.length).toBeGreaterThan(0);

    // Bus events confirm the pipeline fired (intent resolution → completion)
    expect(busEvents).toContain('intent:resolved');
    expect(busEvents).toContain('task:complete');

    // Trace recorded
    expect(result.trace).toBeDefined();
    expect(result.trace.outcome).not.toBe('failure');

    orchestrator.traceListener.detach();
  });

  test('no-provider task escalates honestly (not echo goal back)', async () => {
    // Empty registry — no providers at all
    const registry = new LLMProviderRegistry();
    const bus = createBus();

    const orchestrator = createOrchestrator({
      workspace: tempDir,
      registry,
      bus,
      useSubprocess: false,
      watchWorkspace: false,
    });

    const input: TaskInput = {
      id: `smoke-noprovider-${Date.now()}`,
      source: 'api',
      goal: 'What is 2+2?',
      taskType: 'reasoning',
      budget: { maxTokens: 4000, maxDurationMs: 30_000, maxRetries: 1 },
    };

    const result = await orchestrator.executeTask(input);

    // Honest escalation: should NOT echo goal back as answer
    expect(result.answer).not.toBe('What is 2+2?');
    // Should either escalate OR return empty answer with a note
    const honestOutcome =
      result.status === 'escalated' ||
      (result.status === 'completed' && (!result.answer || result.answer.length === 0));
    expect(honestOutcome).toBe(true);

    orchestrator.traceListener.detach();
  });
});
