/**
 * Gap 3 — Self-application boundary.
 *
 * When a #3 CLI Delegate (Claude Code / GitHub Copilot CLI) is asked to
 * modify its own subsystem (`src/orchestrator/external-coding-cli/`),
 * the orchestrator MUST refuse autonomous dispatch and surface an
 * honest "requires human approval" failure.
 *
 * Source-of-truth ref: docs/foundation/self-modification-protocol.md §6.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBus, type VinyanBusEvents } from '../../../src/core/bus.ts';
import { createMockProvider } from '../../../src/orchestrator/llm/mock-provider.ts';
import { LLMProviderRegistry } from '../../../src/orchestrator/llm/provider-registry.ts';
import {
  CodingCliWorkflowStrategy,
  type CodingCliWorkflowOutcome,
  type CodingCliWorkflowStep,
} from '../../../src/orchestrator/external-coding-cli/external-coding-cli-workflow-strategy.ts';
import type { ExternalCodingCliController } from '../../../src/orchestrator/external-coding-cli/external-coding-cli-controller.ts';
import { createOrchestrator as _createOrchestrator } from '../../../src/orchestrator/factory.ts';
import { clearIntentResolverCache } from '../../../src/orchestrator/intent-resolver.ts';
import type { TaskInput } from '../../../src/orchestrator/types.ts';

let tempDir: string;

beforeEach(() => {
  clearIntentResolverCache();
  tempDir = mkdtempSync(join(tmpdir(), 'vinyan-self-app-'));
  mkdirSync(join(tempDir, 'src'), { recursive: true });
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

class FakeStrategy extends CodingCliWorkflowStrategy {
  ranCount = 0;
  constructor() {
    super({} as ExternalCodingCliController);
  }
  override async run(_step: CodingCliWorkflowStep): Promise<CodingCliWorkflowOutcome> {
    this.ranCount++;
    return {
      status: 'completed',
      providerId: 'claude-code',
      capabilities: null,
      sessionId: 'fake',
      claim: null,
      verification: null,
      reason: 'should not be reached',
    } as CodingCliWorkflowOutcome;
  }
}

const createOrchestrator: typeof _createOrchestrator = (opts) =>
  _createOrchestrator({ workerBootstrapPolicy: 'grandfather', ...opts });

function makeRegistry() {
  const registry = new LLMProviderRegistry();
  const content = JSON.stringify({ proposedMutations: [], proposedToolCalls: [], uncertainties: [] });
  registry.register(createMockProvider({ id: 'mock/fast', tier: 'fast', responseContent: content }));
  registry.register(createMockProvider({ id: 'mock/balanced', tier: 'balanced', responseContent: content }));
  registry.register(createMockProvider({ id: 'mock/powerful', tier: 'powerful', responseContent: content }));
  return registry;
}

function makeInput(goal: string): TaskInput {
  return {
    id: 'task-self-app',
    source: 'cli',
    goal,
    taskType: 'reasoning',
    budget: { maxTokens: 4000, maxDurationMs: 5000, maxRetries: 1 },
  };
}

describe('Gap 3 — Self-Application Boundary', () => {
  test('refuses #3 dispatch when target path is under src/orchestrator/external-coding-cli/', async () => {
    const fake = new FakeStrategy();
    const bus = createBus();
    const events: VinyanBusEvents['coding-cli:self_application_detected'][] = [];
    bus.on('coding-cli:self_application_detected', (p) => events.push(p));

    const orchestrator = createOrchestrator({
      workspace: tempDir,
      registry: makeRegistry(),
      bus,
      useSubprocess: false,
      codingCliStrategyOverride: fake,
    });

    const result = await orchestrator.executeTask(
      makeInput(
        'ask claude code cli to refactor src/orchestrator/external-coding-cli/runner.ts',
      ),
    );

    // 1. Strategy was NEVER called — boundary refused dispatch.
    expect(fake.ranCount).toBe(0);
    // 2. Self-application event fired.
    expect(events.length).toBe(1);
    expect(events[0]?.providerId).toBe('claude-code');
    expect(events[0]?.targetPaths.some((p) =>
      p.includes('src/orchestrator/external-coding-cli/'),
    )).toBe(true);
    // 3. Task surfaces honest failure.
    expect(result.status).toBe('failed');
    expect(result.answer ?? '').toContain('Self-application detected');
    expect(result.answer ?? '').toContain('human approval');
    // 4. Trace approach + decisionId.
    expect(result.trace.approach).toBe('external-coding-cli');
    const provenance = result.trace.governanceProvenance as
      | { decisionId?: string }
      | undefined;
    expect(provenance?.decisionId).toContain('external-coding-cli-self-application');
  });

  test('NORMAL paths under other directories still dispatch normally', async () => {
    const fake = new FakeStrategy();
    const orchestrator = createOrchestrator({
      workspace: tempDir,
      registry: makeRegistry(),
      useSubprocess: false,
      codingCliStrategyOverride: fake,
    });
    await orchestrator.executeTask(
      makeInput('ask claude code cli to refactor src/foo.ts'),
    );
    // Strategy WAS called — boundary doesn't apply to non-self paths.
    expect(fake.ranCount).toBe(1);
  });
});
