/**
 * Core-loop integration — External Coding CLI dispatch path.
 *
 * Verifies the EXACT failure case from the user-reported bug:
 *
 *   "สั่งงาน claude code cli ช่วยรัน verify flow เปิดบัญชีกองทุน
 *    `/Users/phumin.k/appl/Docs/s1_design_spec`"
 *
 * Pre-fix this prompt routed as:
 *   intent-resolver → direct-tool → shell_exec
 *   → "Shell command contains dangerous metacharacter".
 *
 * Post-fix the same prompt MUST:
 *   1. Resolve to `agentic-workflow` with `externalCodingCli` populated.
 *   2. Dispatch through `codingCliStrategy.run(...)` (NOT shell_exec).
 *   3. Trace `approach='external-coding-cli'`, NOT `direct-tool-shortcircuit`.
 *   4. When `codingCliStrategy` is missing → status='failed' with a clear
 *      "External Coding CLI not configured" reason — NEVER shell metacharacter.
 *   5. No bus event mentioning "dangerous metacharacter".
 *
 * The test uses a fake `CodingCliWorkflowStrategy` injected via
 * `codingCliStrategyOverride` so we can capture the `step` argument
 * without spawning a subprocess.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBus } from '../../src/core/bus.ts';
import { createMockProvider } from '../../src/orchestrator/llm/mock-provider.ts';
import { LLMProviderRegistry } from '../../src/orchestrator/llm/provider-registry.ts';
import {
  CodingCliWorkflowStrategy,
  type CodingCliWorkflowOutcome,
  type CodingCliWorkflowStep,
} from '../../src/orchestrator/external-coding-cli/external-coding-cli-workflow-strategy.ts';
import type { ExternalCodingCliController } from '../../src/orchestrator/external-coding-cli/external-coding-cli-controller.ts';
import { createOrchestrator as _createOrchestrator } from '../../src/orchestrator/factory.ts';
import { clearIntentResolverCache } from '../../src/orchestrator/intent-resolver.ts';
import type { TaskInput } from '../../src/orchestrator/types.ts';

// The exact prompt from the bug report — used verbatim across tests.
const EXACT_THAI_PROMPT =
  'สั่งงาน claude code cli ช่วยรัน verify flow เปิดบัญชีกองทุน `/Users/phumin.k/appl/Docs/s1_design_spec`';

const TARGET_PATH = '/Users/phumin.k/appl/Docs/s1_design_spec';

let tempDir: string;

beforeEach(() => {
  clearIntentResolverCache();
  tempDir = mkdtempSync(join(tmpdir(), 'vinyan-ecc-coreloop-'));
  mkdirSync(join(tempDir, 'src'), { recursive: true });
  // Disable all oracles so the pipeline focuses on routing only.
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

function makeRegistry() {
  const registry = new LLMProviderRegistry();
  // Generic fallback content — should never actually be consumed in the
  // ECC fast-path because the deterministic pre-classifier wins. Provided
  // so factory wiring succeeds.
  const content = JSON.stringify({
    proposedMutations: [],
    proposedToolCalls: [],
    uncertainties: [],
  });
  registry.register(createMockProvider({ id: 'mock/fast', tier: 'fast', responseContent: content }));
  registry.register(createMockProvider({ id: 'mock/balanced', tier: 'balanced', responseContent: content }));
  registry.register(createMockProvider({ id: 'mock/powerful', tier: 'powerful', responseContent: content }));
  return registry;
}

/**
 * Build a fake CodingCliWorkflowStrategy that captures the `step` and
 * returns a configured outcome. Bypasses the real controller / subprocess
 * layer entirely.
 *
 * We extend the real class so the dispatch in core-loop.ts (which type-checks
 * `deps.codingCliStrategy` as `CodingCliWorkflowStrategy`) accepts this fake.
 */
class FakeStrategy extends CodingCliWorkflowStrategy {
  capturedStep: CodingCliWorkflowStep | null = null;
  outcome: CodingCliWorkflowOutcome;
  constructor(outcome?: Partial<CodingCliWorkflowOutcome>) {
    // The base class needs *some* controller, but we never call into it.
    super({} as ExternalCodingCliController);
    this.outcome = {
      status: 'completed',
      providerId: 'claude-code',
      capabilities: null,
      sessionId: 'fake-session',
      claim: {
        status: 'completed',
        summary: 'fake CLI run',
        changedFiles: [],
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
    this.capturedStep = step;
    return this.outcome;
  }
}

const createOrchestrator: typeof _createOrchestrator = (opts) =>
  _createOrchestrator({ workerBootstrapPolicy: 'grandfather', ...opts });

function makeInput(goal: string, overrides?: Partial<TaskInput>): TaskInput {
  return {
    id: 't-ecc-1',
    source: 'cli',
    goal,
    taskType: 'reasoning',
    budget: { maxTokens: 4000, maxDurationMs: 5000, maxRetries: 1 },
    ...overrides,
  };
}

describe('core-loop ECC dispatch — exact Thai prompt', () => {
  test('routes through codingCliStrategy.run (NOT shell_exec)', async () => {
    const fake = new FakeStrategy();
    const bus = createBus();
    const events: Array<{ name: string; payload: unknown }> = [];
    // Subscribe to every event that could plausibly carry a shell_exec
    // tool call or a "dangerous metacharacter" rejection. If any of these
    // fire we're either still routing through shell_exec or surfacing the
    // pre-fix error message.
    const watchEvents: Array<keyof typeof bus extends never ? never : string> = [
      'task:complete',
      'task:escalate',
      'tools:executed',
      'tool:approval_required',
      'tool:failure_classified',
      'worker:error',
      'oracle:verdict',
      'critic:verdict',
    ];
    for (const name of watchEvents) {
      // biome-ignore lint/suspicious/noExplicitAny: event names are typed but iterating dynamic.
      bus.on(name as never, ((payload: unknown) => {
        events.push({ name, payload });
      }) as never);
    }

    const orchestrator = createOrchestrator({
      workspace: tempDir,
      registry: makeRegistry(),
      bus,
      useSubprocess: false,
      codingCliStrategyOverride: fake,
    });

    const result = await orchestrator.executeTask(makeInput(EXACT_THAI_PROMPT));

    // 1. The fake strategy was called exactly once.
    expect(fake.capturedStep).not.toBeNull();
    const step = fake.capturedStep!;

    // 2. Step inputs reflect the resolver's classification.
    expect(step.providerId).toBe('claude-code');
    // The exact verb / provider is stripped — the rootGoal carries the work.
    expect(step.rootGoal.toLowerCase()).toContain('verify flow');
    // The directory path was promoted to allowedScope (via targetPaths).
    expect(step.allowedScope).toContain(TARGET_PATH);
    // cwd defaults to the directory path (no file extension) when present.
    expect(step.cwd).toBe(TARGET_PATH);

    // 3. Trace approach is 'external-coding-cli'.
    expect(result.trace.approach).toBe('external-coding-cli');
    expect(result.trace.workerId).toBe('external-coding-cli');

    // 4. Governance provenance carries provider/mode/targets in evidence.
    //    `buildShortCircuitProvenance` puts evidence under `wasDerivedFrom`.
    const provenance = result.trace.governanceProvenance as
      | { decisionId?: string; wasDerivedFrom?: Array<{ summary?: string }> }
      | undefined;
    // decisionId is namespaced with `intentResolver:<taskId>:` prefix.
    expect(provenance?.decisionId).toContain('external-coding-cli-dispatch');
    const evSummaries = (provenance?.wasDerivedFrom ?? []).map((e) => e.summary ?? '').join('|');
    expect(evSummaries).toContain('provider=claude-code');
    expect(evSummaries).toContain(`targets=${TARGET_PATH}`);

    // 5. Result answer mentions External Coding CLI.
    expect(result.answer ?? '').toContain('External Coding CLI');

    // 6. No shell_exec tool was invoked anywhere on the bus.
    const shellEvents = events.filter((e) =>
      JSON.stringify(e.payload ?? {}).toLowerCase().includes('shell_exec'),
    );
    expect(shellEvents.length).toBe(0);

    // 7. CRITICAL: no event or trace mentions "dangerous metacharacter".
    const allText = JSON.stringify(events) + JSON.stringify(result);
    expect(allText.toLowerCase()).not.toContain('dangerous metacharacter');
  });

  test('missing codingCliStrategy → honest unsupported failure (NOT shell_exec)', async () => {
    const bus = createBus();
    const events: Array<{ name: string; payload: unknown }> = [];
    // Subscribe to every event that could plausibly carry a shell_exec
    // tool call or a "dangerous metacharacter" rejection. If any of these
    // fire we're either still routing through shell_exec or surfacing the
    // pre-fix error message.
    const watchEvents: Array<keyof typeof bus extends never ? never : string> = [
      'task:complete',
      'task:escalate',
      'tools:executed',
      'tool:approval_required',
      'tool:failure_classified',
      'worker:error',
      'oracle:verdict',
      'critic:verdict',
    ];
    for (const name of watchEvents) {
      // biome-ignore lint/suspicious/noExplicitAny: event names are typed but iterating dynamic.
      bus.on(name as never, ((payload: unknown) => {
        events.push({ name, payload });
      }) as never);
    }

    const orchestrator = createOrchestrator({
      workspace: tempDir,
      registry: makeRegistry(),
      bus,
      useSubprocess: false,
      // Explicitly disable — simulates a deployment where the CLI
      // controller couldn't be wired (binary missing / config disabled).
      codingCliStrategyOverride: null,
    });

    const result = await orchestrator.executeTask(makeInput(EXACT_THAI_PROMPT));

    // 1. Status is 'failed' (not 'completed').
    expect(result.status).toBe('failed');

    // 2. Reason mentions "External Coding CLI" + "not configured".
    expect(result.answer ?? '').toContain('External Coding CLI not configured');

    // 3. Trace carries the dedicated unsupported decisionId.
    expect(result.trace.approach).toBe('external-coding-cli');
    const provenance = result.trace.governanceProvenance as
      | { decisionId?: string }
      | undefined;
    expect(provenance?.decisionId).toContain('external-coding-cli-unsupported');

    // 4. NO shell_exec / dangerous metacharacter anywhere.
    const allText = JSON.stringify(events) + JSON.stringify(result);
    expect(allText.toLowerCase()).not.toContain('dangerous metacharacter');
    expect(allText).not.toContain('shell_exec');
  });
});

describe('core-loop ECC dispatch — variants', () => {
  test('English prompt with file path also routes to ECC, not shell_exec', async () => {
    const fake = new FakeStrategy();
    const orchestrator = createOrchestrator({
      workspace: tempDir,
      registry: makeRegistry(),
      useSubprocess: false,
      codingCliStrategyOverride: fake,
    });

    const result = await orchestrator.executeTask(
      makeInput('ask claude code cli to refactor src/foo.ts'),
    );

    expect(fake.capturedStep).not.toBeNull();
    expect(fake.capturedStep?.providerId).toBe('claude-code');
    expect(result.trace.approach).toBe('external-coding-cli');
  });

  test('GitHub Copilot prompt routes to ECC with copilot providerId', async () => {
    const fake = new FakeStrategy({ providerId: 'github-copilot' });
    const orchestrator = createOrchestrator({
      workspace: tempDir,
      registry: makeRegistry(),
      useSubprocess: false,
      codingCliStrategyOverride: fake,
    });

    const result = await orchestrator.executeTask(
      makeInput('use gh copilot to suggest a fix for src/foo.ts'),
    );

    expect(fake.capturedStep).not.toBeNull();
    expect(fake.capturedStep?.providerId).toBe('github-copilot');
    expect(result.trace.approach).toBe('external-coding-cli');
  });
});
