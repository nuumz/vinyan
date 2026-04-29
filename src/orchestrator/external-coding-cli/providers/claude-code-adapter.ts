/**
 * Claude Code adapter — drives the local `claude` CLI.
 *
 * Verified against `claude --help` (v2.1.x):
 *   - headless via `-p` (one-shot print mode).
 *   - stream-json input/output for machine-driven interactive sessions
 *     (`--input-format=stream-json --output-format=stream-json`). This is
 *     the SDK protocol — no PTY required.
 *   - `--include-hook-events` augments stream-json with hook lifecycle.
 *   - `--include-partial-messages` for incremental deltas.
 *   - `--session-id <uuid>` lets us pin Vinyan's task id to a Claude session
 *     id for replay and resume.
 *   - `--permission-mode default` is the safe default. We never auto-set
 *     `bypassPermissions` — the operator must opt in via config.
 *   - `--dangerously-skip-permissions` is REJECTED at command-build time
 *     unless `allowDangerousSkipPermissions: true` in operator config.
 *   - `--disallowedTools` / `--allowedTools` for tool gating.
 *   - `--add-dir` to scope file access.
 *   - `--settings <json>` lets us inject a hook bridge config without
 *     touching the user's settings.json on disk.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

export interface ClaudeCodeAdapterOptions {
  /** Override binary path. Default: PATH lookup of `claude`. */
  binaryPath?: string;
  /** When true, the operator has explicitly opted into YOLO mode. */
  allowDangerousSkipPermissions?: boolean;
  /** Allow-listed env vars to forward. */
  allowEnv?: string[];
}

export class ClaudeCodeAdapter implements CodingCliProviderAdapter {
  readonly id = 'claude-code' as const;
  readonly displayName = 'Claude Code';

  private detection: CodingCliDetectionResult | null = null;
  private capabilities: CodingCliCapabilities = ZERO_CAPABILITIES;
  private readonly options: ClaudeCodeAdapterOptions;

  constructor(options: ClaudeCodeAdapterOptions = {}) {
    this.options = options;
  }

  async detect(): Promise<CodingCliDetectionResult> {
    const binaryPath = this.options.binaryPath ?? (await whichBinary('claude'));
    if (!binaryPath) {
      const result: CodingCliDetectionResult = {
        providerId: this.id,
        available: false,
        binaryPath: null,
        version: null,
        variant: 'unknown',
        notes: ['claude binary not on PATH — install Claude Code to enable this provider'],
        capabilities: ZERO_CAPABILITIES,
      };
      this.detection = result;
      return result;
    }
    const probe = await probeBinary(binaryPath, ['--version'], { timeoutMs: 5_000 });
    const helpProbe = await probeBinary(binaryPath, ['--help'], { timeoutMs: 5_000 });
    const versionLine = probe.stdout.trim() || helpProbe.stdout.split('\n', 1)[0]?.trim() || null;
    const helpText = `${helpProbe.stdout}\n${helpProbe.stderr}`;
    const capabilities: CodingCliCapabilities = {
      headless: helpText.includes('-p, --print') || helpText.includes('--print'),
      interactive: true,
      // Stream-json over stdin/stdout — works without a TTY.
      streamProtocol: helpText.includes('stream-json') || helpText.includes('--input-format'),
      resume: helpText.includes('--resume') || helpText.includes('-c, --continue'),
      nativeHooks: helpText.includes('--include-hook-events') || helpText.includes('hooks'),
      jsonOutput: helpText.includes('--output-format'),
      approvalPrompts: helpText.includes('--permission-mode'),
      toolEvents: helpText.includes('--include-hook-events') || helpText.includes('--output-format'),
      fileEditEvents: helpText.includes('--include-hook-events'),
      transcriptAccess: helpText.includes('--output-format'),
      statusCommand: helpText.includes('doctor'),
      cancelSupport: true,
    };
    const result: CodingCliDetectionResult = {
      providerId: this.id,
      available: probe.exitCode === 0 || helpProbe.exitCode === 0,
      binaryPath,
      version: versionLine,
      variant: 'full',
      notes: [],
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
    const args: string[] = [
      '-p', // print mode = non-interactive
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-hook-events',
      '--include-partial-messages',
      '--no-session-persistence',
      '--exclude-dynamic-system-prompt-sections',
    ];
    args.push('--session-id', this.deriveProviderSessionId(task.taskId));
    if (task.model) args.push('--model', task.model);
    if (task.allowedScope.length > 0) args.push('--add-dir', ...task.allowedScope);
    args.push('--permission-mode', this.derivePermissionMode(task));
    return {
      bin: this.detection.binaryPath,
      args,
      cwd: task.cwd,
      env: this.buildEnv(),
      stdinPersistent: true,
    };
  }

  buildInteractiveCommand(session: CodingCliSessionConfig): CodingCliCommand {
    if (!this.detection?.binaryPath) {
      throw new Error('claude-code: cannot build interactive command, binary not detected');
    }
    const args: string[] = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--include-hook-events',
      '--include-partial-messages',
      '--no-session-persistence',
      '--exclude-dynamic-system-prompt-sections',
    ];
    args.push('--session-id', this.deriveProviderSessionId(session.taskId));
    if (session.model) args.push('--model', session.model);
    if (session.allowedScope.length > 0) args.push('--add-dir', ...session.allowedScope);
    args.push('--permission-mode', this.derivePermissionMode(session));
    return {
      bin: this.detection.binaryPath,
      args,
      cwd: session.cwd,
      env: this.buildEnv(),
      stdinPersistent: true,
    };
  }

  formatInitialPrompt(task: CodingCliTask): string {
    return formatStreamJsonUserMessage(buildSystemPrompt(task));
  }

  formatFollowupMessage(message: string): string {
    return formatStreamJsonUserMessage(message);
  }

  parseOutputDelta(chunk: string, ctx: ParseContext): CodingCliParsedEvent[] {
    return parseClaudeStreamJson(ctx, chunk);
  }

  parseFinalResult(output: string): CodingCliResult | null {
    return parseFinalResult(output, { expectedProviderId: this.id });
  }

  detectApprovalRequest(_output: string, hookEvent?: HookEvent): CodingCliApprovalRequest | null {
    if (!hookEvent) return null;
    if (hookEvent.hookName !== 'PreToolUse') return null;
    const tool = hookEvent.toolName ?? 'Tool';
    const scope = scopeFromTool(tool);
    return {
      requestId: `${hookEvent.codingCliSessionId}-${hookEvent.timestamp}`,
      scope,
      summary: `Claude Code tool: ${tool}`,
      detail: JSON.stringify(hookEvent.toolInput ?? {}, null, 2),
      providerData: { hookEvent },
    };
  }

  respondToApproval(request: CodingCliApprovalRequest, decision: ApprovalDecision): CodingCliInput {
    // Claude Code stream-json: the SDK protocol responds to permission
    // requests via a permission_response JSON message.
    const payload = {
      type: 'permission_response',
      request_id: request.requestId,
      decision: decision === 'approved' ? 'allow' : 'deny',
    };
    return { kind: 'stdin', bytes: `${JSON.stringify(payload)}\n` };
  }

  async setupHookBridge(ctx: HookBridgeContext): Promise<HookBridgeSetupResult> {
    // Native bridge: write a temp settings.json that points each hook to a
    // tiny shim which appends to the JSONL sink. With --include-hook-events
    // we ALSO get hook events on stream-json directly — so this provider
    // is hybrid by default.
    const shimPath = path.join(ctx.configDir, 'hook-shim.sh');
    const settingsPath = path.join(ctx.configDir, 'settings.json');
    const shim = `#!/bin/sh
# Vinyan Coding-CLI hook shim — emits one JSONL line per invocation.
SINK="${ctx.eventLogPath.replace(/"/g, '\\"')}"
HOOK_NAME="$1"
TIMESTAMP=$(date +%s%3N)
BODY=$(cat 2>/dev/null || true)
printf '{"providerId":"claude-code","codingCliSessionId":"%s","taskId":"%s","hookName":"%s","eventType":"%s","cwd":"%s","timestamp":%s,"raw":%s}\\n' \\
  "${ctx.codingCliSessionId}" \\
  "${ctx.taskId}" \\
  "$HOOK_NAME" \\
  "$HOOK_NAME" \\
  "${ctx.cwd.replace(/"/g, '\\"')}" \\
  "$TIMESTAMP" \\
  "\${BODY:-{}}" >> "$SINK"
`;
    fs.mkdirSync(ctx.configDir, { recursive: true });
    fs.writeFileSync(shimPath, shim, { mode: 0o755 });
    const settings = {
      hooks: {
        PreToolUse: [{ command: `${shimPath} PreToolUse` }],
        PostToolUse: [{ command: `${shimPath} PostToolUse` }],
        Stop: [{ command: `${shimPath} Stop` }],
        SubagentStop: [{ command: `${shimPath} SubagentStop` }],
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    return {
      mode: 'hybrid',
      extraEnv: {},
      extraArgs: ['--settings', settingsPath],
      teardown: async () => {
        try { fs.rmSync(shimPath, { force: true }); } catch {}
        try { fs.rmSync(settingsPath, { force: true }); } catch {}
      },
    };
  }

  async cleanup(_sessionId: string): Promise<void> {
    void _sessionId;
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private derivePermissionMode(task: { approvalPolicy: { allowDangerousSkipPermissions: boolean } }): string {
    if (this.options.allowDangerousSkipPermissions && task.approvalPolicy.allowDangerousSkipPermissions) {
      // Both adapter-level AND task-level explicit opt-in required for YOLO.
      return 'bypassPermissions';
    }
    return 'default';
  }

  private deriveProviderSessionId(taskId: string): string {
    // Claude requires a UUID; we derive one deterministically from the
    // taskId so replays match.
    return formatUuid(hashToUuid(`vinyan-coding-cli/${this.id}/${taskId}`));
  }

  private buildEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    const allow = this.options.allowEnv ?? [
      'PATH', 'HOME', 'TERM', 'LANG', 'LC_ALL',
      'FORCE_COLOR', 'NO_COLOR',
      'CLAUDE_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
    ];
    for (const key of allow) {
      const value = process.env[key];
      if (typeof value === 'string') env[key] = value;
    }
    // Required for `tmpdir()` lookup below.
    if (!env.HOME) env.HOME = os.homedir();
    return env;
  }
}

// ── stream-json parsing ─────────────────────────────────────────────────

function parseClaudeStreamJson(ctx: ParseContext, chunk: string): CodingCliParsedEvent[] {
  ctx.buffer = (ctx.buffer ?? '') + chunk;
  const out: CodingCliParsedEvent[] = [];
  let cursor = 0;
  while (cursor < ctx.buffer.length) {
    const newline = ctx.buffer.indexOf('\n', cursor);
    if (newline === -1) break;
    const line = ctx.buffer.slice(cursor, newline).trim();
    cursor = newline + 1;
    if (!line) continue;
    let parsed: { type?: string; [key: string]: unknown } | null = null;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Not JSON — emit as raw output delta so the user sees something.
      out.push({ kind: 'output_delta', channel: 'stdout', text: line });
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const type = (parsed.type as string | undefined) ?? '';
    switch (type) {
      case 'system':
        if (typeof parsed.session_id === 'string') {
          out.push({ kind: 'provider_session', providerSessionId: parsed.session_id });
        }
        break;
      case 'assistant':
      case 'partial_assistant_message': {
        const content = parsed.message as { content?: unknown[] } | undefined;
        if (content && Array.isArray(content.content)) {
          for (const item of content.content) {
            if (item && typeof item === 'object' && (item as { type?: string }).type === 'text') {
              const text = String((item as { text?: unknown }).text ?? '');
              if (text) out.push({ kind: 'output_delta', channel: 'stdout', text });
            }
          }
        }
        break;
      }
      case 'tool_use':
      case 'tool_started': {
        const toolName = String(parsed.tool_name ?? parsed.name ?? 'Tool');
        out.push({
          kind: 'tool_started',
          toolName,
          summary: String(parsed.summary ?? ''),
          safeInput: typeof parsed.input === 'object' && parsed.input !== null ? (parsed.input as Record<string, unknown>) : undefined,
        });
        break;
      }
      case 'tool_result':
      case 'tool_completed': {
        const toolName = String(parsed.tool_name ?? parsed.name ?? 'Tool');
        const ok = (parsed.is_error as boolean | undefined) !== true;
        out.push({
          kind: 'tool_completed',
          toolName,
          ok,
          durationMs: typeof parsed.duration_ms === 'number' ? (parsed.duration_ms as number) : undefined,
          errorMessage: ok ? undefined : String(parsed.error ?? 'tool error'),
        });
        if (toolName === 'Edit' || toolName === 'Write') {
          const filePath = String((parsed.input as { file_path?: unknown } | undefined)?.file_path ?? '');
          if (filePath) {
            out.push({ kind: 'file_changed', path: filePath, changeType: 'modified' });
          }
        }
        break;
      }
      case 'hook_event': {
        const hookName = String(parsed.hook_name ?? '');
        if (hookName === 'PreToolUse') {
          const tool = String((parsed.tool as { name?: unknown } | undefined)?.name ?? 'Tool');
          out.push({
            kind: 'approval_required',
            raw: {
              requestId: String(parsed.request_id ?? `${ctx.providerSessionId ?? ''}-${Date.now()}`),
              scope: scopeFromTool(tool),
              summary: `Claude Code tool: ${tool}`,
              detail: JSON.stringify((parsed.tool as { input?: unknown } | undefined)?.input ?? {}, null, 2),
              providerData: parsed,
            },
          });
        } else if (hookName === 'Stop' || hookName === 'SubagentStop') {
          out.push({ kind: 'state', state: 'completed', reason: hookName });
        }
        break;
      }
      case 'result': {
        // The SDK final-result envelope. Look for a CODING_CLI_RESULT block
        // in the rendered text — if found, surface it.
        const text = typeof parsed.result === 'string' ? parsed.result : '';
        if (text) {
          const result = parseFinalResult(text);
          if (result) out.push({ kind: 'result', result });
          else out.push({ kind: 'output_delta', channel: 'stdout', text });
        }
        break;
      }
      default:
        // Unknown stream-json type — preserve raw for diagnostics.
        out.push({ kind: 'output_delta', channel: 'stdout', text: line });
    }
  }
  ctx.buffer = ctx.buffer.slice(cursor);
  return out;
}

function scopeFromTool(toolName: string): CodingCliApprovalRequest['scope'] {
  const lower = toolName.toLowerCase();
  if (lower === 'bash' || lower === 'shell') return 'shell';
  if (lower === 'edit' || lower === 'write' || lower === 'multiedit') return 'edit';
  if (lower.includes('git')) return 'git';
  return 'tool';
}

function formatStreamJsonUserMessage(text: string): string {
  return `${JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  })}\n`;
}

function buildSystemPrompt(task: CodingCliTask): string {
  return [
    `# Vinyan Coding CLI — Task ${task.taskId}`,
    `Provider: claude-code`,
    `Workspace: ${task.cwd}`,
    `Allowed scope: ${task.allowedScope.length === 0 ? '(workspace root)' : task.allowedScope.join(', ')}`,
    `Forbidden scope: ${task.forbiddenScope.length === 0 ? '(none)' : task.forbiddenScope.join(', ')}`,
    '',
    `## Goal`,
    task.rootGoal,
    '',
    task.notes ? `## Notes\n${task.notes}\n` : '',
    `## Approval policy`,
    `- Read-only: ${task.approvalPolicy.autoApproveReadOnly ? 'auto-approve allowed' : 'requires approval'}`,
    `- Edits: ${task.approvalPolicy.requireHumanForWrites ? 'require human approval' : 'allowed'}`,
    `- Shell: ${task.approvalPolicy.requireHumanForShell ? 'require human approval' : 'allowed'}`,
    `- Git: ${task.approvalPolicy.requireHumanForGit ? 'require human approval' : 'allowed'}`,
    `- Bypass: ${task.approvalPolicy.allowDangerousSkipPermissions ? 'OPERATOR-ENABLED YOLO MODE' : 'NEVER bypass permission prompts'}`,
    '',
    `## Reporting protocol`,
    `When you finish, emit EXACTLY ONE block of the form:`,
    `<CODING_CLI_RESULT>`,
    `{`,
    `  "status": "completed | failed | blocked | needs_approval | partial",`,
    `  "providerId": "claude-code",`,
    `  "summary": "...",`,
    `  "changedFiles": ["..."],`,
    `  "commandsRun": ["..."],`,
    `  "testsRun": ["..."],`,
    `  "decisions": [{"decision":"...","reason":"...","alternatives":["..."]}],`,
    `  "verification": {"claimedPassed": true, "details": "..."},`,
    `  "blockers": [],`,
    `  "requiresHumanReview": false`,
    `}`,
    `</CODING_CLI_RESULT>`,
    ``,
    `Vinyan parses this block but does NOT trust it — Vinyan runs its own`,
    `verification (oracles, tests, goal evaluator) before accepting completion.`,
    ``,
    `If you need permission to run a tool, ASK via the standard approval`,
    `prompt — do NOT bypass.`,
  ]
    .filter(Boolean)
    .join('\n');
}

// ── Tiny deterministic UUID v4-ish (no external dep) ───────────────────

function hashToUuid(input: string): string {
  // 128-bit FNV-style hash → 32 hex chars. Not cryptographic, but
  // deterministic per input which is what we need.
  let h1 = 0x9dc5_ca91 >>> 0;
  let h2 = 0xb52e_1d3f >>> 0;
  let h3 = 0x6c8d_a743 >>> 0;
  let h4 = 0xff05_b1c1 >>> 0;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x83492c19) >>> 0;
    h3 = Math.imul(h3 ^ c, 0x1c8364a1) >>> 0;
    h4 = Math.imul(h4 ^ c, 0x9e3779b1) >>> 0;
  }
  const hex = [h1, h2, h3, h4].map((n) => n.toString(16).padStart(8, '0')).join('');
  return hex;
}

function formatUuid(hex32: string): string {
  // Insert dashes per RFC 4122 layout: 8-4-4-4-12.
  return `${hex32.slice(0, 8)}-${hex32.slice(8, 12)}-4${hex32.slice(13, 16)}-8${hex32.slice(17, 20)}-${hex32.slice(20, 32)}`;
}
