import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ApprovalGate } from '../../../src/orchestrator/approval-gate.ts';
import { createBus } from '../../../src/core/bus.ts';
import {
  CodingCliConfigSchema,
  CodingCliWorkflowStrategy,
  EXTERNAL_CODING_CLI_METADATA,
  EXTERNAL_CODING_CLI_STRATEGY,
  ExternalCodingCliController,
  registerCodingCliStrategy,
} from '../../../src/orchestrator/external-coding-cli/index.ts';
import { CodingCliVerifier } from '../../../src/orchestrator/external-coding-cli/external-coding-cli-verifier.ts';
import { WorkflowRegistry } from '../../../src/orchestrator/workflow/workflow-registry.ts';
import { FakeAdapter, makeFakeResultBlock } from './fake-adapter.ts';

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vinyan-coding-cli-wf-'));
}

describe('CodingCliWorkflowStrategy', () => {
  let workspace: string;
  beforeEach(() => {
    workspace = tmpWorkspace();
  });
  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('registry registration and metadata correctness', () => {
    const reg = new WorkflowRegistry();
    expect(reg.has(EXTERNAL_CODING_CLI_STRATEGY)).toBe(false);
    registerCodingCliStrategy(reg);
    expect(reg.get(EXTERNAL_CODING_CLI_STRATEGY)).toEqual(EXTERNAL_CODING_CLI_METADATA);
    // idempotent
    registerCodingCliStrategy(reg);
    expect(reg.list().filter((s) => s === EXTERNAL_CODING_CLI_STRATEGY)).toHaveLength(1);
  });

  test('completed → outcome.status=completed', async () => {
    const block = makeFakeResultBlock({
      providerId: 'claude-code',
      summary: 'wrote file',
      changedFiles: [],
    });
    const adapters = [
      new FakeAdapter({
        id: 'claude-code',
        capabilities: { headless: true, interactive: true },
        stdoutScript: [block],
      }),
    ];
    const controller = new ExternalCodingCliController({
      bus: createBus(),
      approvalGate: new ApprovalGate(createBus()),
      config: CodingCliConfigSchema.parse({}),
      adapters,
      buildVerifier: () => new CodingCliVerifier({ cwd: workspace, skipGitDiffCheck: true }),
    });
    await controller.detectProviders();
    const strategy = new CodingCliWorkflowStrategy(controller);
    const outcome = await strategy.run({
      taskId: 'wf-1',
      rootGoal: 'write file',
      cwd: workspace,
      providerId: 'claude-code',
    });
    expect(outcome.status).toBe('completed');
    expect(outcome.providerId).toBe('claude-code');
  });

  test('limited variant → outcome.status=unsupported', async () => {
    const adapters = [new FakeAdapter({ id: 'github-copilot', variant: 'limited' })];
    const controller = new ExternalCodingCliController({
      bus: createBus(),
      approvalGate: new ApprovalGate(createBus()),
      config: CodingCliConfigSchema.parse({}),
      adapters,
    });
    await controller.detectProviders();
    const strategy = new CodingCliWorkflowStrategy(controller);
    const outcome = await strategy.run({
      taskId: 'wf-2',
      rootGoal: 'do thing',
      cwd: workspace,
      providerId: 'github-copilot',
    });
    expect(outcome.status).toBe('unsupported');
  });

  test('phantom claim with goal-alignment oracle → outcome.status=failed', async () => {
    const block = makeFakeResultBlock({
      providerId: 'claude-code',
      summary: 'pretended to write missing.ts',
      changedFiles: ['src/missing.ts'],
      verification: { claimedPassed: true, details: 'trust me' },
    });
    const adapters = [
      new FakeAdapter({
        id: 'claude-code',
        capabilities: { headless: true, interactive: true },
        stdoutScript: [block],
      }),
    ];
    const controller = new ExternalCodingCliController({
      bus: createBus(),
      approvalGate: new ApprovalGate(createBus()),
      config: CodingCliConfigSchema.parse({}),
      adapters,
      buildVerifier: () =>
        new CodingCliVerifier({
          cwd: workspace,
          skipGitDiffCheck: true,
          goalAlignmentOracle: async (files) => ({
            ok: files.length > 0 && files.every((f) => fs.existsSync(path.join(workspace, f))),
            detail: 'phantom file',
          }),
        }),
    });
    await controller.detectProviders();
    const strategy = new CodingCliWorkflowStrategy(controller);
    const outcome = await strategy.run({
      taskId: 'wf-3',
      rootGoal: 'liar test',
      cwd: workspace,
      providerId: 'claude-code',
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.verification?.predictionError).toBe(true);
  });

  test('no result envelope → outcome.status=failed', async () => {
    const adapters = [
      new FakeAdapter({
        id: 'claude-code',
        capabilities: { headless: true, interactive: true },
        stdoutScript: ['just chatter, no result envelope'],
      }),
    ];
    const controller = new ExternalCodingCliController({
      bus: createBus(),
      approvalGate: new ApprovalGate(createBus()),
      config: CodingCliConfigSchema.parse({}),
      adapters,
      buildVerifier: () => new CodingCliVerifier({ cwd: workspace, skipGitDiffCheck: true }),
    });
    await controller.detectProviders();
    const strategy = new CodingCliWorkflowStrategy(controller);
    const outcome = await strategy.run({
      taskId: 'wf-4',
      rootGoal: 'silent test',
      cwd: workspace,
      providerId: 'claude-code',
    });
    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toContain('result envelope');
  });
});
