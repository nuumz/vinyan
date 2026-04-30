/**
 * End-to-end synthesis fallback test.
 *
 * Reproduces the production failure: Claude Code exits cleanly but does
 * NOT emit a CODING_CLI_RESULT block. The controller must synthesize a
 * partial claim from session state (extracted assistant text from the
 * stream-json `result` line) instead of failing with "no result envelope
 * emitted".
 *
 * A1 separation preserved: the synthesized claim is `status: 'partial'`
 * and Vinyan's verifier still has final say on whether the work passed.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ApprovalGate } from '../../../src/orchestrator/approval-gate.ts';
import { createBus } from '../../../src/core/bus.ts';
import {
  CodingCliConfigSchema,
  ExternalCodingCliController,
} from '../../../src/orchestrator/external-coding-cli/index.ts';
import { CodingCliVerifier } from '../../../src/orchestrator/external-coding-cli/external-coding-cli-verifier.ts';
import { FakeAdapter } from './fake-adapter.ts';

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vinyan-coding-cli-synth-'));
}

describe('controller — claim synthesis fallback (A9 graceful degradation)', () => {
  let workspace: string;
  beforeEach(() => {
    workspace = tmpWorkspace();
  });
  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  test('clean exit without CODING_CLI_RESULT block + stream-json result line → synthesized partial claim', async () => {
    // Simulate Claude Code's stream-json output: one assistant text line
    // and one final `result` line. NO CODING_CLI_RESULT block anywhere.
    const streamJsonLines = [
      JSON.stringify({ type: 'system', session_id: 'sess-x' }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'Looking at the spec...' }] },
      }),
      JSON.stringify({
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'I have analyzed the design spec at the requested path. The open-account flow has 3 phases: validation, KYC, activation. Each is independently testable.',
        session_id: 'sess-x',
      }),
    ];

    const adapter = new FakeAdapter({
      id: 'claude-code',
      capabilities: { headless: true, interactive: true, jsonOutput: true, toolEvents: true },
      stdoutScript: streamJsonLines,
    });

    const controller = new ExternalCodingCliController({
      bus: createBus(),
      approvalGate: new ApprovalGate(createBus()),
      config: CodingCliConfigSchema.parse({}),
      adapters: [adapter],
      buildVerifier: () => new CodingCliVerifier({ cwd: workspace, skipGitDiffCheck: true }),
    });
    await controller.detectProviders();

    const outcome = await controller.runHeadless({
      taskId: 'synth-test',
      rootGoal: 'analyze the spec',
      cwd: workspace,
      mode: 'headless',
      providerId: 'claude-code',
      timeoutMs: 30_000,
      idleTimeoutMs: 5_000,
      maxOutputBytes: 1_000_000,
      allowedScope: [],
      forbiddenScope: [],
      approvalPolicy: {
        autoApproveReadOnly: false,
        requireHumanForWrites: true,
        requireHumanForShell: true,
        requireHumanForGit: true,
        allowDangerousSkipPermissions: false,
      },
    } as never);

    // Synthesized claim is present...
    expect(outcome.claim).not.toBeNull();
    // ...status is 'partial' (NEVER 'completed' — only verifier can promote)...
    expect(outcome.claim?.status).toBe('partial');
    // ...claimedPassed is false (we cannot infer pass without the envelope)...
    expect(outcome.claim?.verification.claimedPassed).toBe(false);
    // ...summary contains the assistant's final text.
    expect(outcome.claim?.summary).toContain('open-account flow');
    expect(outcome.claim?.requiresHumanReview).toBe(true);
  });

  test('clean exit with NO output at all → still failed (no signal to synthesize from)', async () => {
    // Adapter that emits nothing — the printf will print just "\n".
    const adapter = new FakeAdapter({
      id: 'claude-code',
      capabilities: { headless: true, interactive: true },
      stdoutScript: [],
    });

    const controller = new ExternalCodingCliController({
      bus: createBus(),
      approvalGate: new ApprovalGate(createBus()),
      config: CodingCliConfigSchema.parse({}),
      adapters: [adapter],
      buildVerifier: () => new CodingCliVerifier({ cwd: workspace, skipGitDiffCheck: true }),
    });
    await controller.detectProviders();

    const outcome = await controller.runHeadless({
      taskId: 'no-output',
      rootGoal: 'do nothing',
      cwd: workspace,
      mode: 'headless',
      providerId: 'claude-code',
      timeoutMs: 30_000,
      idleTimeoutMs: 5_000,
      maxOutputBytes: 1_000_000,
      allowedScope: [],
      forbiddenScope: [],
      approvalPolicy: {
        autoApproveReadOnly: false,
        requireHumanForWrites: true,
        requireHumanForShell: true,
        requireHumanForGit: true,
        allowDangerousSkipPermissions: false,
      },
    } as never);

    // No signal → no ghost claim. Honest failure.
    expect(outcome.claim).toBeNull();
    expect(outcome.session.state()).toBe('failed');
  });
});
