/**
 * GitHub Copilot adapter — drives the local Copilot CLI, with fallback to
 * the legacy `gh copilot` wrapper.
 *
 * Two install variants we may encounter:
 *
 *   1. Standalone agentic Copilot CLI (`copilot` on PATH, or
 *      `~/.local/share/gh/copilot`). Has `-p "prompt"` headless mode, an
 *      interactive REPL, and `--allow-tool 'shell(git)'` for tool gating.
 *      Does NOT expose native lifecycle hooks today — wrapper bridge only.
 *
 *   2. Legacy `gh copilot` wrapper (extension-style: `gh copilot suggest`,
 *      `gh copilot explain`). This variant is LIMITED — it only suggests
 *      or explains commands, it does not autonomously edit code. Detected
 *      via `gh copilot --help`, capabilities clamp to suggest/explain only,
 *      and `variant: 'limited'` is reported. Vinyan's controller refuses
 *      to route full coding-edit tasks to this variant unless the operator
 *      explicitly opts in.
 *
 *   3. Not installed. `gh copilot` may prompt the user to download. We do
 *      NOT trigger that download — we just report `available: false` with
 *      install instructions.
 *
 * Honest disclosure (A1): when Copilot is in 'limited' variant, the
 * adapter sets `interactive: false`, `headless: false`, `nativeHooks: false`
 * etc. so the controller surfaces `unsupported-capability` instead of
 * pretending the CLI can edit code autonomously.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  type ApprovalDecision,
  type CodingCliApprovalRequest,
  type CodingCliCapabilities,
  type CodingCliCommand,
  type CodingCliDetectionResult,
  type CodingCliInput,
  type CodingCliParsedEvent,
  type CodingCliProviderAdapter,
  type CodingCliResult,
  type CodingCliSessionConfig,
  type CodingCliTask,
  type HookBridgeContext,
  type HookBridgeSetupResult,
  type HookEvent,
  type ParseContext,
  ZERO_CAPABILITIES,
} from '../types.ts';
import { parseFinalResult } from '../external-coding-cli-result-parser.ts';
import { probeBinary, whichBinary } from './provider-detection.ts';

export interface GitHubCopilotAdapterOptions {
  binaryPath?: string;
  /** When true, we tolerate `gh copilot` legacy wrapper for routing. */
  legacyGhCopilotFallback?: boolean;
  allowDangerousSkipPermissions?: boolean;
  allowEnv?: string[];
}

const STANDALONE_CANDIDATES = [
  // gh-managed install location.
  path.join(os.homedir(), '.local/share/gh/copilot'),
];

export class GitHubCopilotAdapter implements CodingCliProviderAdapter {
  readonly id = 'github-copilot' as const;
  readonly displayName = 'GitHub Copilot';

  private detection: CodingCliDetectionResult | null = null;
  private capabilities: CodingCliCapabilities = ZERO_CAPABILITIES;
  /** When true, we're driving the legacy `gh copilot` wrapper. */
  private useGhFallback = false;
  private readonly options: GitHubCopilotAdapterOptions;

  constructor(options: GitHubCopilotAdapterOptions = {}) {
    this.options = options;
  }

  async detect(): Promise<CodingCliDetectionResult> {
    let binaryPath = this.options.binaryPath ?? null;
    let variant: CodingCliDetectionResult['variant'] = 'unknown';
    const notes: string[] = [];

    if (!binaryPath) {
      // Look for standalone first.
      binaryPath = (await whichBinary('copilot'))
        ?? STANDALONE_CANDIDATES.find((p) => safeIsExecutable(p))
        ?? null;
    }
    if (binaryPath) {
      const probe = await probeBinary(binaryPath, ['--help'], { timeoutMs: 5_000 });
      const helpText = `${probe.stdout}\n${probe.stderr}`;
      if (helpText.includes('Cannot find GitHub Copilot CLI') || helpText.includes('Install GitHub Copilot CLI')) {
        // We hit a wrapper that wants to download — refuse.
        notes.push('Copilot CLI not installed — `gh copilot` wants to install it. Install manually first.');
        binaryPath = null;
      } else if (helpText.includes('-p,') || helpText.includes('--prompt') || helpText.includes('"Summarize this week') || helpText.includes('--allow-tool')) {
        variant = 'full';
      } else {
        variant = 'limited';
        notes.push('Copilot CLI binary present but does not advertise -p/--allow-tool — limited variant');
      }
    }

    // Fallback: try `gh copilot` if standalone not found and operator allows.
    if (!binaryPath && this.options.legacyGhCopilotFallback !== false) {
      const ghPath = await whichBinary('gh');
      if (ghPath) {
        const probe = await probeBinary(ghPath, ['copilot', '--help'], { timeoutMs: 5_000 });
        const text = `${probe.stdout}\n${probe.stderr}`;
        if (text.includes('GitHub Copilot CLI') && !text.includes('Cannot find GitHub Copilot CLI')) {
          // gh wrapper exists and Copilot installed via gh.
          binaryPath = ghPath;
          this.useGhFallback = true;
          variant = text.includes('-p ') ? 'full' : 'limited';
          if (variant === 'limited') {
            notes.push('Using `gh copilot` legacy wrapper — limited to suggest/explain mode unless extended');
          }
        } else if (text.includes('Cannot find GitHub Copilot CLI') || text.includes('Install GitHub Copilot CLI?')) {
          notes.push('`gh copilot` is available but Copilot CLI itself is not installed — run `gh copilot` once interactively to install');
        }
      }
    }

    if (!binaryPath) {
      const result: CodingCliDetectionResult = {
        providerId: this.id,
        available: false,
        binaryPath: null,
        version: null,
        variant: 'unknown',
        notes: notes.length > 0 ? notes : ['github-copilot binary not found — install via https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli'],
        capabilities: ZERO_CAPABILITIES,
      };
      this.detection = result;
      return result;
    }

    const versionProbe = await probeBinary(binaryPath, this.useGhFallback ? ['copilot', '--version'] : ['--version'], { timeoutMs: 5_000 });
    const version = versionProbe.stdout.trim() || null;

    const capabilities: CodingCliCapabilities = variant === 'full'
      ? {
          headless: true,
          // Copilot's CLI does not expose a documented stream protocol —
          // we only drive it headlessly. Marking interactive: false avoids
          // the controller routing it to a stdin-pipe loop that would hang
          // on its readline UX.
          interactive: false,
          streamProtocol: false,
          // Copilot's resume support is not standardized — mark false until
          // we can verify against the installed binary.
          resume: false,
          nativeHooks: false,
          jsonOutput: false,
          approvalPrompts: true,
          toolEvents: false,
          fileEditEvents: false,
          transcriptAccess: false,
          statusCommand: false,
          cancelSupport: true,
        }
      : { ...ZERO_CAPABILITIES };

    const result: CodingCliDetectionResult = {
      providerId: this.id,
      available: variant === 'full',
      binaryPath,
      version,
      variant,
      notes,
      capabilities,
    };
    this.detection = result;
    this.capabilities = capabilities;
    return result;
  }

  getCapabilities(): CodingCliCapabilities {
    return this.capabilities;
  }

  buildHeadlessCommand(task: CodingCliTask): CodingCliCommand | null {
    if (!this.detection?.available || !this.detection.binaryPath) return null;
    if (!this.capabilities.headless) return null;
    const args: string[] = [];
    if (this.useGhFallback) {
      args.push('copilot', '-p', this.formatInitialPrompt(task));
    } else {
      args.push('-p', this.formatInitialPrompt(task));
    }
    // Conservative tool allow-list when the operator hasn't enabled YOLO.
    // We rely on Vinyan's approval bridge to gate writes/git via wrapper-
    // observed approval prompts, since Copilot has no native hooks.
    const allowTool = this.deriveAllowTool(task);
    if (allowTool) args.push('--allow-tool', allowTool);
    return {
      bin: this.detection.binaryPath,
      args,
      cwd: task.cwd,
      env: this.buildEnv(),
      stdinPersistent: false,
    };
  }

  buildInteractiveCommand(session: CodingCliSessionConfig): CodingCliCommand {
    if (!this.detection?.binaryPath) {
      throw new Error('github-copilot: cannot build interactive command, binary not detected');
    }
    const args: string[] = [];
    if (this.useGhFallback) {
      args.push('copilot');
    }
    return {
      bin: this.detection.binaryPath,
      args,
      cwd: session.cwd,
      env: this.buildEnv(),
      stdinPersistent: true,
    };
  }

  formatInitialPrompt(task: CodingCliTask): string {
    return [
      `[Vinyan task ${task.taskId}] ${task.rootGoal}`,
      ``,
      `Workspace: ${task.cwd}`,
      `Allowed scope: ${task.allowedScope.length === 0 ? '(workspace root)' : task.allowedScope.join(', ')}`,
      `Forbidden scope: ${task.forbiddenScope.length === 0 ? '(none)' : task.forbiddenScope.join(', ')}`,
      ``,
      `Approval policy:`,
      `- Read-only: ${task.approvalPolicy.autoApproveReadOnly ? 'auto-approve allowed' : 'requires approval'}`,
      `- Edits: ${task.approvalPolicy.requireHumanForWrites ? 'require human approval' : 'allowed'}`,
      `- Shell: ${task.approvalPolicy.requireHumanForShell ? 'require human approval' : 'allowed'}`,
      `- Git: ${task.approvalPolicy.requireHumanForGit ? 'require human approval' : 'allowed'}`,
      ``,
      `When done, emit exactly one <CODING_CLI_RESULT>{...JSON...}</CODING_CLI_RESULT>`,
      `block following the same schema as Claude Code (status, providerId,`,
      `summary, changedFiles, commandsRun, testsRun, decisions, verification,`,
      `blockers, requiresHumanReview).`,
      ``,
      `Set "providerId": "github-copilot". Vinyan will run its own verification`,
      `before accepting completion — do not skip permission prompts.`,
    ].join('\n');
  }

  formatFollowupMessage(message: string): string {
    return `${message}\n`;
  }

  parseOutputDelta(chunk: string, ctx: ParseContext): CodingCliParsedEvent[] {
    // Copilot has no structured stream protocol we can rely on. We treat
    // stdout as plain text + look for our own result envelope. Tool/file
    // events come from the wrapper hook bridge (git diff watcher) at the
    // controller layer, not from this parser.
    ctx.buffer = (ctx.buffer ?? '') + chunk;
    const out: CodingCliParsedEvent[] = [];
    if (chunk.length > 0) {
      out.push({ kind: 'output_delta', channel: 'stdout', text: chunk });
    }
    // Heuristic approval detection: a line that starts with "Allow" or
    // ends with "[y/N]" looks like a prompt waiting for input.
    for (const line of chunk.split('\n')) {
      const trimmed = line.trim();
      if (/^allow\b/i.test(trimmed) || /\[(y\/n|y\/N)\]\s*$/i.test(trimmed)) {
        out.push({
          kind: 'approval_required',
          raw: {
            requestId: `gh-${Date.now()}`,
            scope: 'unknown',
            summary: 'Copilot is asking for permission',
            detail: trimmed,
            providerData: { line: trimmed },
          },
        });
      }
    }
    // Look for completed result envelope.
    const result = parseFinalResult(ctx.buffer, { expectedProviderId: this.id });
    if (result) {
      out.push({ kind: 'result', result });
      ctx.buffer = '';
    }
    return out;
  }

  parseFinalResult(output: string): CodingCliResult | null {
    return parseFinalResult(output, { expectedProviderId: this.id });
  }

  detectApprovalRequest(output: string, hookEvent?: HookEvent): CodingCliApprovalRequest | null {
    if (hookEvent) {
      return {
        requestId: hookEvent.codingCliSessionId + '-' + hookEvent.timestamp,
        scope: 'unknown',
        summary: hookEvent.eventType,
        detail: JSON.stringify(hookEvent.toolInput ?? {}, null, 2),
        providerData: { hookEvent },
      };
    }
    const match = /\[(y\/N|y\/n)\]\s*$/m.exec(output);
    if (!match) return null;
    return {
      requestId: `gh-${Date.now()}`,
      scope: 'unknown',
      summary: 'Copilot prompt awaiting approval',
      detail: output.slice(Math.max(0, output.length - 1024)),
      providerData: { promptTail: match[0] },
    };
  }

  respondToApproval(_request: CodingCliApprovalRequest, decision: ApprovalDecision): CodingCliInput {
    return { kind: 'stdin', bytes: decision === 'approved' ? 'y\n' : 'N\n' };
  }

  async setupHookBridge(_ctx: HookBridgeContext): Promise<HookBridgeSetupResult> {
    // Copilot has no native hook system today — wrapper-only.
    return {
      mode: 'wrapper',
      extraEnv: {},
      extraArgs: [],
      teardown: async () => {},
    };
  }

  async cleanup(_sessionId: string): Promise<void> {
    void _sessionId;
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private deriveAllowTool(task: CodingCliTask): string | null {
    const allow: string[] = [];
    if (task.approvalPolicy.autoApproveReadOnly) allow.push('shell(git status)', 'shell(git diff)', 'shell(ls)');
    return allow.length > 0 ? allow.join(',') : null;
  }

  private buildEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    const allow = this.options.allowEnv ?? [
      'PATH', 'HOME', 'TERM', 'LANG', 'LC_ALL',
      'FORCE_COLOR', 'NO_COLOR',
      'GH_TOKEN', 'GITHUB_TOKEN',
    ];
    for (const key of allow) {
      const value = process.env[key];
      if (typeof value === 'string') env[key] = value;
    }
    if (!env.HOME) env.HOME = os.homedir();
    return env;
  }
}

function safeIsExecutable(file: string): boolean {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return false;
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
