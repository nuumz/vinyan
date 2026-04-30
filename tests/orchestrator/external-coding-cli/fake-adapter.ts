/**
 * Test-only fake adapter — synthesizes deterministic CLI output without
 * spawning a real subprocess. Used by controller, routing, and
 * verification tests where the goal is to exercise the control plane,
 * not the process layer.
 */
import {
  type ApprovalDecision,
  type CodingCliApprovalRequest,
  type CodingCliCapabilities,
  type CodingCliCommand,
  type CodingCliDetectionResult,
  type CodingCliInput,
  type CodingCliParsedEvent,
  type CodingCliProviderAdapter,
  type CodingCliProviderId,
  type CodingCliResult,
  type CodingCliSessionConfig,
  type CodingCliTask,
  type ParseContext,
  ZERO_CAPABILITIES,
  RESULT_CLOSE_TAG,
  RESULT_OPEN_TAG,
} from '../../../src/orchestrator/external-coding-cli/types.ts';
import { parseFinalResult } from '../../../src/orchestrator/external-coding-cli/external-coding-cli-result-parser.ts';

export interface FakeAdapterOptions {
  id: CodingCliProviderId;
  capabilities?: Partial<CodingCliCapabilities>;
  variant?: 'full' | 'limited' | 'unknown';
  binaryPath?: string | null;
  /** Whatever the fake binary writes to stdout. */
  stdoutScript?: string[];
  /** Force buildHeadlessCommand to return null (disables headless). */
  noHeadless?: boolean;
}

export class FakeAdapter implements CodingCliProviderAdapter {
  readonly id: CodingCliProviderId;
  readonly displayName: string;
  private readonly opts: FakeAdapterOptions;
  constructor(opts: FakeAdapterOptions) {
    this.opts = opts;
    this.id = opts.id;
    this.displayName = `Fake ${opts.id}`;
  }
  async detect(): Promise<CodingCliDetectionResult> {
    const capabilities: CodingCliCapabilities = {
      ...ZERO_CAPABILITIES,
      headless: true,
      interactive: true,
      cancelSupport: true,
      ...(this.opts.capabilities ?? {}),
    };
    return {
      providerId: this.id,
      available: this.opts.binaryPath !== null,
      binaryPath: this.opts.binaryPath ?? '/usr/bin/echo',
      version: 'fake-1.0',
      variant: this.opts.variant ?? 'full',
      notes: [],
      capabilities,
    };
  }
  getCapabilities(): CodingCliCapabilities {
    return {
      ...ZERO_CAPABILITIES,
      headless: true,
      interactive: true,
      cancelSupport: true,
      ...(this.opts.capabilities ?? {}),
    };
  }
  buildHeadlessCommand(task: CodingCliTask): CodingCliCommand | null {
    if (this.opts.noHeadless) return null;
    const text = (this.opts.stdoutScript ?? []).join('\n') + '\n';
    return {
      bin: '/usr/bin/printf',
      args: ['%s', text],
      cwd: task.cwd,
      env: { PATH: process.env.PATH ?? '' },
      stdinPersistent: false,
    };
  }
  buildInteractiveCommand(session: CodingCliSessionConfig): CodingCliCommand {
    const text = (this.opts.stdoutScript ?? []).join('\n') + '\n';
    return {
      bin: '/usr/bin/printf',
      args: ['%s', text],
      cwd: session.cwd,
      env: { PATH: process.env.PATH ?? '' },
      stdinPersistent: false,
    };
  }
  formatInitialPrompt(task: CodingCliTask): string {
    return `[fake] ${task.rootGoal}\n`;
  }
  formatFollowupMessage(message: string): string {
    return `${message}\n`;
  }
  parseOutputDelta(chunk: string, ctx: ParseContext): CodingCliParsedEvent[] {
    ctx.buffer += chunk;
    const events: CodingCliParsedEvent[] = [];
    if (chunk.length > 0) events.push({ kind: 'output_delta', channel: 'stdout', text: chunk });
    const result = parseFinalResult(ctx.buffer, { expectedProviderId: this.id });
    if (result) {
      events.push({ kind: 'result', result });
    }
    return events;
  }
  parseFinalResult(output: string): CodingCliResult | null {
    return parseFinalResult(output, { expectedProviderId: this.id });
  }
  detectApprovalRequest(): CodingCliApprovalRequest | null {
    return null;
  }
  respondToApproval(_request: CodingCliApprovalRequest, decision: ApprovalDecision): CodingCliInput {
    return { kind: 'stdin', bytes: decision === 'approved' ? 'y\n' : 'n\n' };
  }
}

export function makeFakeResultBlock(overrides: Partial<CodingCliResult> & { providerId: CodingCliProviderId }): string {
  const result: CodingCliResult = {
    status: 'completed',
    summary: 'fake summary',
    changedFiles: [],
    commandsRun: [],
    testsRun: [],
    decisions: [],
    verification: { claimedPassed: true, details: '' },
    blockers: [],
    requiresHumanReview: false,
    ...overrides,
  };
  return `${RESULT_OPEN_TAG}\n${JSON.stringify(result)}\n${RESULT_CLOSE_TAG}`;
}
