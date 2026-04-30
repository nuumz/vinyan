/**
 * Routing-guard contract — interactive routing requires streamProtocol.
 * Mirrors the falsifiable trigger documented in
 * `external-coding-cli-pty-adapter.ts`: a TTY-only CLI MUST be refused
 * rather than silently routed onto the pipe wrapper, where it would
 * hang on `isatty()` checks.
 */
import { describe, expect, test } from 'bun:test';
import { ApprovalGate } from '../../../src/orchestrator/approval-gate.ts';
import { createBus } from '../../../src/core/bus.ts';
import {
  CodingCliConfigSchema,
  ExternalCodingCliController,
} from '../../../src/orchestrator/external-coding-cli/index.ts';
import { FakeAdapter } from './fake-adapter.ts';

function controller(adapters: FakeAdapter[]) {
  return new ExternalCodingCliController({
    bus: createBus(),
    approvalGate: new ApprovalGate(createBus()),
    config: CodingCliConfigSchema.parse({}),
    adapters,
  });
}

describe('routing guard — interactive requires streamProtocol', () => {
  test('pickProvider drops candidates that lack streamProtocol when interactive is needed', async () => {
    const adapters = [
      new FakeAdapter({
        id: 'github-copilot',
        capabilities: { headless: true, interactive: true, streamProtocol: false }, // TTY-only
      }),
      new FakeAdapter({
        id: 'claude-code',
        capabilities: { headless: true, interactive: true, streamProtocol: true },
      }),
    ];
    const c = controller(adapters);
    await c.detectProviders();
    const decision = c.pickProvider({ needsInteractive: true });
    expect(decision?.providerId).toBe('claude-code');
  });

  test('pickProvider returns null when ALL providers lack streamProtocol for interactive', async () => {
    const adapters = [
      new FakeAdapter({
        id: 'claude-code',
        capabilities: { headless: true, interactive: true, streamProtocol: false },
      }),
      new FakeAdapter({
        id: 'github-copilot',
        capabilities: { headless: true, interactive: true, streamProtocol: false },
      }),
    ];
    const c = controller(adapters);
    await c.detectProviders();
    const decision = c.pickProvider({ needsInteractive: true });
    expect(decision).toBeNull();
  });

  test('createSession with mode=interactive on TTY-only provider → unsupported-capability', async () => {
    const adapters = [
      new FakeAdapter({
        id: 'github-copilot',
        capabilities: { headless: true, interactive: true, streamProtocol: false },
      }),
    ];
    const c = controller(adapters);
    await c.detectProviders();
    const session = await c.createSession({
      taskId: 'tty-only',
      rootGoal: 'do thing',
      cwd: '/tmp',
      mode: 'interactive',
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
    } as never, 'github-copilot');
    expect(session.state()).toBe('unsupported-capability');
  });

  test('headless mode on a TTY-only-but-headless-capable provider routes normally', async () => {
    const adapters = [
      new FakeAdapter({
        id: 'github-copilot',
        // Like real Copilot: interactive: false (refuses), headless: true.
        capabilities: { headless: true, interactive: false, streamProtocol: false },
      }),
    ];
    const c = controller(adapters);
    await c.detectProviders();
    const decision = c.pickProvider({ needsHeadless: true });
    expect(decision?.providerId).toBe('github-copilot');
  });
});
