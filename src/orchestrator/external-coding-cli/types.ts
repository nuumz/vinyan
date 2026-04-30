/**
 * External Coding CLI — provider-neutral types, schemas, capability matrix,
 * state machine, event taxonomy, and result contract.
 *
 * One control-plane drives heterogeneous CLI coding agents (Claude Code,
 * GitHub Copilot, future). Adapters translate. The orchestrator stays
 * deterministic (A3) and treats every adapter as a zero-trust worker (A6)
 * whose self-reported "done" must be verified by Vinyan (A1).
 *
 * Adversarial robustness is a corollary of A6 + A8 + A9 — these contracts
 * exist so external CLI output cannot smuggle authority into Vinyan.
 */
import { z } from 'zod';

// ── Provider identity & capabilities ────────────────────────────────────

export const PROVIDER_IDS = ['claude-code', 'github-copilot'] as const;
export type CodingCliProviderId = (typeof PROVIDER_IDS)[number];

/**
 * What a provider can actually do, after on-disk detection. Adapters MUST
 * report only verified capabilities — a `headless: true` claim that throws
 * on first invocation is an A1 violation. When unsure, return `false`.
 */
export interface CodingCliCapabilities {
  /** One-shot prompt mode (e.g., `claude -p ...`, `gh copilot -p ...`). */
  headless: boolean;
  /** Persistent stdin/stdout session — may be PTY or piped streams. */
  interactive: boolean;
  /**
   * Provider can be driven over a pipe-based stream protocol (no TTY
   * required). When `interactive: true && streamProtocol: false`, routing
   * MUST refuse interactive sessions — we do NOT spawn TTY-only CLIs over
   * pipes (they block on isatty() checks). See `external-coding-cli-pty-adapter.ts`.
   */
  streamProtocol: boolean;
  /** Resume a prior session ID (`-r`/`-c` style). */
  resume: boolean;
  /** Provider has an out-of-band hook callback mechanism we can use. */
  nativeHooks: boolean;
  /** Provider emits structured JSON or stream-json output. */
  jsonOutput: boolean;
  /** Provider raises permission prompts the wrapper can detect & answer. */
  approvalPrompts: boolean;
  /** Provider emits per-tool start/end events the wrapper can ingest. */
  toolEvents: boolean;
  /** Provider emits per-file edit events. */
  fileEditEvents: boolean;
  /** Provider exposes a transcript file we can read for replay. */
  transcriptAccess: boolean;
  /** Provider has a status / health command we can poll. */
  statusCommand: boolean;
  /** Wrapper can cancel by killing PID without leaving the workspace dirty. */
  cancelSupport: boolean;
}

export const ZERO_CAPABILITIES: CodingCliCapabilities = {
  headless: false,
  interactive: false,
  streamProtocol: false,
  resume: false,
  nativeHooks: false,
  jsonOutput: false,
  approvalPrompts: false,
  toolEvents: false,
  fileEditEvents: false,
  transcriptAccess: false,
  statusCommand: false,
  cancelSupport: false,
};

// ── Detection ───────────────────────────────────────────────────────────

export const CodingCliDetectionResultSchema = z.object({
  providerId: z.enum(PROVIDER_IDS),
  available: z.boolean(),
  binaryPath: z.string().nullable(),
  version: z.string().nullable(),
  /**
   * `limited` means the binary exists but the install variant cannot do
   * full coding tasks (e.g., legacy `gh copilot suggest/explain`). These
   * providers MUST NOT be selected for autonomous code-edit routing
   * unless the operator opted in.
   */
  variant: z.enum(['full', 'limited', 'unknown']),
  /**
   * Empty when `available: true` — populated when detection failed so the
   * UI can show the user what to install.
   */
  notes: z.array(z.string()).default([]),
  capabilities: z.object({
    headless: z.boolean(),
    interactive: z.boolean(),
    streamProtocol: z.boolean(),
    resume: z.boolean(),
    nativeHooks: z.boolean(),
    jsonOutput: z.boolean(),
    approvalPrompts: z.boolean(),
    toolEvents: z.boolean(),
    fileEditEvents: z.boolean(),
    transcriptAccess: z.boolean(),
    statusCommand: z.boolean(),
    cancelSupport: z.boolean(),
  }),
});
export type CodingCliDetectionResult = z.infer<typeof CodingCliDetectionResultSchema>;

// ── Task / session config ───────────────────────────────────────────────

export const ApprovalPolicySchema = z.object({
  autoApproveReadOnly: z.boolean().default(false),
  requireHumanForWrites: z.boolean().default(true),
  requireHumanForShell: z.boolean().default(true),
  requireHumanForGit: z.boolean().default(true),
  /** Operator-explicit override; default OFF (never auto-enable YOLO). */
  allowDangerousSkipPermissions: z.boolean().default(false),
});
export type ApprovalPolicy = z.infer<typeof ApprovalPolicySchema>;

export const CodingCliTaskSchema = z.object({
  taskId: z.string().min(1),
  rootGoal: z.string().min(1),
  cwd: z.string().min(1),
  /** Subset of `cwd` the CLI is allowed to touch. Empty = all of cwd. */
  allowedScope: z.array(z.string()).default([]),
  /** Glob/path patterns the CLI must never touch even if asked. */
  forbiddenScope: z.array(z.string()).default([]),
  /** Provider hint — if absent, controller picks via capability matrix. */
  providerId: z.enum(PROVIDER_IDS).optional(),
  mode: z.enum(['headless', 'interactive', 'auto']).default('auto'),
  approvalPolicy: ApprovalPolicySchema.default(() => ApprovalPolicySchema.parse({})),
  model: z.string().optional(),
  /** Hard wall-clock cap. Adapter clamps to its own min/max. */
  timeoutMs: z.number().int().positive().max(60 * 60 * 1000).default(15 * 60 * 1000),
  /** Idle timeout — no output / no hook activity for this long → stalled. */
  idleTimeoutMs: z.number().int().positive().max(30 * 60 * 1000).default(2 * 60 * 1000),
  /** Cap on captured stdout/stderr per session, in bytes. */
  maxOutputBytes: z.number().int().positive().max(50 * 1024 * 1024).default(4 * 1024 * 1024),
  /** Free-form hint to the prompt template — e.g. "no tests please". */
  notes: z.string().optional(),
  /**
   * Vinyan's session id — propagates so the session SSE stream can
   * membership-filter coding-cli events (event-manifest contract).
   */
  sessionId: z.string().optional(),
  correlationId: z.string().optional(),
});
export type CodingCliTask = z.infer<typeof CodingCliTaskSchema>;

export const CodingCliSessionConfigSchema = CodingCliTaskSchema;
export type CodingCliSessionConfig = CodingCliTask;

// ── Command construction ────────────────────────────────────────────────

export interface CodingCliCommand {
  /** Absolute binary path; never a shell string. */
  bin: string;
  /** argv array — never a single shell command (security: A6). */
  args: string[];
  /** Working directory. Must be inside the sandboxed workspace root. */
  cwd: string;
  /** Allow-listed env. The runner does NOT inherit process.env by default. */
  env: Record<string, string>;
  /** Whether stdin should be kept open for follow-up messages. */
  stdinPersistent: boolean;
  /** Optional path to a JSONL hook event sink the adapter expects. */
  hookSinkPath?: string;
  /** Optional path to the adapter-managed transcript. */
  transcriptPath?: string;
}

// ── State machine ───────────────────────────────────────────────────────

export const SESSION_STATES = [
  'created',
  'starting',
  'ready',
  'running',
  'waiting-input',
  'waiting-approval',
  'planning',
  'editing',
  'running-command',
  'verifying',
  'completed',
  'failed',
  'cancelled',
  'timed-out',
  'crashed',
  'stalled',
  'unsupported-capability',
] as const;
export type CodingCliSessionState = (typeof SESSION_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<CodingCliSessionState> = new Set([
  'completed',
  'failed',
  'cancelled',
  'timed-out',
  'crashed',
  'unsupported-capability',
]);

export function isTerminalState(state: CodingCliSessionState): boolean {
  return TERMINAL_STATES.has(state);
}

// ── Bus event payloads ──────────────────────────────────────────────────

export interface CodingCliEventBase {
  taskId: string;
  /** Vinyan session id (matches `task:start` payload session). */
  sessionId?: string;
  /** Internal Vinyan-side coding-cli session id (different from session_id above). */
  codingCliSessionId: string;
  providerId: CodingCliProviderId;
  /** Provider's own session id, if exposed (Claude `--session-id`). */
  providerSessionId?: string;
  state: CodingCliSessionState;
  ts: number;
  /** Cross-system correlation token. */
  correlationId?: string;
}

export interface CodingCliSessionCreatedEvent extends CodingCliEventBase {
  cwd: string;
  binaryPath: string;
  binaryVersion: string | null;
  capabilities: CodingCliCapabilities;
}

export interface CodingCliStateChangedEvent extends CodingCliEventBase {
  prevState: CodingCliSessionState;
  reason?: string;
}

export interface CodingCliMessageSentEvent extends CodingCliEventBase {
  /** Truncated to maxOutputBytes/8. */
  preview: string;
  bytes: number;
  /** false = initial system prompt; true = follow-up. */
  followup: boolean;
}

export interface CodingCliOutputDeltaEvent extends CodingCliEventBase {
  /** Sub-second-coalesced output chunk; UTF-8. */
  text: string;
  channel: 'stdout' | 'stderr';
}

export interface CodingCliToolStartedEvent extends CodingCliEventBase {
  /** Provider-native tool name (Edit, Bash, Read, ...). */
  toolName: string;
  /** Best-effort summary, never raw secrets. */
  summary: string;
  /** Best-effort safe input (paths, command names — no secrets). */
  safeInput?: Record<string, unknown>;
}

export interface CodingCliToolCompletedEvent extends CodingCliEventBase {
  toolName: string;
  ok: boolean;
  durationMs: number;
  errorMessage?: string;
  /** Best-effort safe result (e.g. byteCount, path). */
  safeResult?: Record<string, unknown>;
}

export interface CodingCliFileChangedEvent extends CodingCliEventBase {
  path: string;
  changeType: 'created' | 'modified' | 'deleted';
  bytes?: number;
}

export interface CodingCliCommandRequestedEvent extends CodingCliEventBase {
  command: string;
  /** Reason the policy/CLI needs human eyes (or `auto-approved`). */
  reason: string;
}

export interface CodingCliCommandCompletedEvent extends CodingCliEventBase {
  command: string;
  exitCode: number | null;
  durationMs: number;
  outputPreview?: string;
}

export interface CodingCliApprovalRequiredEvent extends CodingCliEventBase {
  requestId: string;
  /** Provider-native scope: 'tool', 'edit', 'shell', 'git'. */
  scope: 'tool' | 'edit' | 'shell' | 'git' | 'unknown';
  /** Human-readable summary of what is being asked. */
  summary: string;
  /** Best-effort full text for human display. */
  detail: string;
  /** Auto-policy decision before human override (when applicable). */
  policyDecision: 'auto-approve' | 'require-human' | 'reject';
  policyReason: string;
}

export interface CodingCliApprovalResolvedEvent extends CodingCliEventBase {
  requestId: string;
  decision: 'approved' | 'rejected';
  decidedBy: 'policy' | 'human' | 'timeout';
  decidedAt: number;
  reason?: string;
}

export interface CodingCliDecisionRecordedEvent extends CodingCliEventBase {
  decision: string;
  rationale: string;
  alternatives: string[];
}

export interface CodingCliCheckpointEvent extends CodingCliEventBase {
  label: string;
  detail?: string;
}

export interface CodingCliResultReportedEvent extends CodingCliEventBase {
  /** Parsed result contract (untrusted; verification still runs). */
  claim: CodingCliResult;
}

export interface CodingCliVerificationStartedEvent extends CodingCliEventBase {
  changedFiles: string[];
}

export interface CodingCliVerificationCompletedEvent extends CodingCliEventBase {
  passed: boolean;
  oracleVerdicts: Array<{ name: string; ok: boolean; detail?: string }>;
  testResults?: { passed: number; failed: number; skipped: number };
  /** When CLI claimed pass but verification failed → A7 prediction error. */
  predictionError?: { claimed: boolean; actual: boolean; reason: string };
}

export interface CodingCliCompletedEvent extends CodingCliEventBase {
  finalStatus: 'completed' | 'partial';
  summary: string;
}

export interface CodingCliFailedEvent extends CodingCliEventBase {
  reason: string;
  errorClass: 'cli_crash' | 'timeout' | 'verification' | 'policy' | 'unknown';
}

export interface CodingCliStalledEvent extends CodingCliEventBase {
  idleMs: number;
  lastSignalAt: number;
}

export interface CodingCliCancelledEvent extends CodingCliEventBase {
  cancelledBy: 'user' | 'system' | 'parent-task';
  reason?: string;
}

export interface CodingCliSessionStartedEvent extends CodingCliEventBase {
  pid: number | null;
  command: string;
}

// ── Adapter-emitted parsed events ───────────────────────────────────────
//
// What `parseOutputDelta` returns. The runner translates these into bus
// events. Keeping the parser → bus translation in the runner means
// adapters never depend on `bus.ts` directly (testability).

export type CodingCliParsedEvent =
  | { kind: 'output_delta'; channel: 'stdout' | 'stderr'; text: string }
  | { kind: 'tool_started'; toolName: string; summary: string; safeInput?: Record<string, unknown> }
  | {
      kind: 'tool_completed';
      toolName: string;
      ok: boolean;
      durationMs?: number;
      errorMessage?: string;
      safeResult?: Record<string, unknown>;
    }
  | { kind: 'file_changed'; path: string; changeType: 'created' | 'modified' | 'deleted'; bytes?: number }
  | { kind: 'command_requested'; command: string; reason: string }
  | { kind: 'command_completed'; command: string; exitCode: number | null; durationMs: number; outputPreview?: string }
  | { kind: 'approval_required'; raw: CodingCliApprovalRequest }
  | { kind: 'state'; state: CodingCliSessionState; reason?: string }
  | { kind: 'checkpoint'; label: string; detail?: string }
  | { kind: 'decision'; decision: string; rationale: string; alternatives: string[] }
  | { kind: 'result'; result: CodingCliResult }
  | { kind: 'provider_session'; providerSessionId: string };

export interface ParseContext {
  /** Accumulated bytes so the parser can match across chunks. */
  buffer: string;
  /** Most-recent provider-native session id (if any). */
  providerSessionId?: string;
  /** Track the active tool span so `tool_completed` can compute duration. */
  activeToolStartedAt?: number;
}

// ── Approval bridge contract ────────────────────────────────────────────

export interface CodingCliApprovalRequest {
  requestId: string;
  scope: 'tool' | 'edit' | 'shell' | 'git' | 'unknown';
  summary: string;
  detail: string;
  /** Provider-native data the adapter needs to send back the response. */
  providerData: Record<string, unknown>;
}

export type ApprovalDecision = 'approved' | 'rejected';

/**
 * Concrete input the adapter sends back to its CLI to resolve the prompt.
 * Could be:
 *   - 'stdin' for sessions where the prompt is on stdin (type yes/no).
 *   - 'file' for adapters that drop a JSON file the CLI watches.
 *   - 'noop' when the provider has no recovery path (unsupported-capability).
 *   - 'http' for hook bridges that respond via HTTP callback.
 */
export type CodingCliInput =
  | { kind: 'stdin'; bytes: string }
  | { kind: 'file'; path: string; contents: string }
  | { kind: 'http'; method: string; url: string; body: string }
  | { kind: 'signal'; signal: NodeJS.Signals }
  | { kind: 'noop'; reason: string };

// ── Hook bridge ─────────────────────────────────────────────────────────

export const HookBridgeModeSchema = z.enum(['native', 'wrapper', 'hybrid', 'off']);
export type HookBridgeMode = z.infer<typeof HookBridgeModeSchema>;

export interface HookBridgeContext {
  providerId: CodingCliProviderId;
  taskId: string;
  codingCliSessionId: string;
  cwd: string;
  /** Where the bridge writes JSONL events the runner ingests. */
  eventLogPath: string;
  /** Adapter-specific config root the bridge can write into (e.g., temp settings.json). */
  configDir: string;
}

export interface HookBridgeSetupResult {
  mode: HookBridgeMode;
  /** Extra env / args the runner must pass to the CLI to activate hooks. */
  extraEnv: Record<string, string>;
  extraArgs: string[];
  /** Cleanup hook to run on session end (delete temp settings, etc). */
  teardown(): Promise<void>;
}

/**
 * Normalized hook event format — what every adapter MUST produce, regardless
 * of native vs wrapper provenance. Persisted verbatim for replay (A8).
 */
export const HookEventSchema = z.object({
  providerId: z.enum(PROVIDER_IDS),
  codingCliSessionId: z.string().min(1),
  taskId: z.string().min(1),
  hookName: z.string().min(1),
  eventType: z.string().min(1),
  toolName: z.string().optional(),
  toolInput: z.unknown().optional(),
  toolResult: z.unknown().optional(),
  cwd: z.string().optional(),
  files: z.array(z.string()).optional(),
  timestamp: z.number().int().nonnegative(),
  raw: z.unknown().optional(),
});
export type HookEvent = z.infer<typeof HookEventSchema>;

// ── Result contract ─────────────────────────────────────────────────────

export const CodingCliResultStatusSchema = z.enum([
  'completed',
  'failed',
  'blocked',
  'needs_approval',
  'partial',
]);
export type CodingCliResultStatus = z.infer<typeof CodingCliResultStatusSchema>;

export const CodingCliResultDecisionSchema = z.object({
  decision: z.string().min(1),
  reason: z.string().min(1),
  alternatives: z.array(z.string()).default([]),
});
export type CodingCliResultDecision = z.infer<typeof CodingCliResultDecisionSchema>;

export const CodingCliResultVerificationSchema = z.object({
  claimedPassed: z.boolean(),
  details: z.string().default(''),
});
export type CodingCliResultVerification = z.infer<typeof CodingCliResultVerificationSchema>;

export const CodingCliResultSchema = z.object({
  status: CodingCliResultStatusSchema,
  providerId: z.enum(PROVIDER_IDS),
  summary: z.string().default(''),
  changedFiles: z.array(z.string()).default([]),
  commandsRun: z.array(z.string()).default([]),
  testsRun: z.array(z.string()).default([]),
  decisions: z.array(CodingCliResultDecisionSchema).default([]),
  verification: CodingCliResultVerificationSchema.default({ claimedPassed: false, details: '' }),
  blockers: z.array(z.string()).default([]),
  requiresHumanReview: z.boolean().default(false),
});
export type CodingCliResult = z.infer<typeof CodingCliResultSchema>;

/**
 * Marker tags the prompt template instructs both providers to emit. The
 * parser is strict: arbitrary text outside the tags is ignored, but the JSON
 * inside MUST validate against the schema or the result is rejected. A1
 * gate: parsing succeeds → claim is recorded → Vinyan still verifies before
 * acceptance.
 */
export const RESULT_OPEN_TAG = '<CODING_CLI_RESULT>';
export const RESULT_CLOSE_TAG = '</CODING_CLI_RESULT>';

// ── Verification (Vinyan-side, not CLI-side) ────────────────────────────

export interface CodingCliVerificationOutcome {
  passed: boolean;
  oracleVerdicts: Array<{ name: string; ok: boolean; detail?: string }>;
  testResults?: { passed: number; failed: number; skipped: number };
  /** True when the CLI claimed pass but verification failed (A7). */
  predictionError: boolean;
  reason?: string;
}

// ── Adapter interface ───────────────────────────────────────────────────

export interface CodingCliProviderAdapter {
  readonly id: CodingCliProviderId;
  readonly displayName: string;
  detect(): Promise<CodingCliDetectionResult>;
  getCapabilities(): CodingCliCapabilities;
  /**
   * Build a one-shot command. Returns null if the provider can't run
   * headlessly — caller falls back to interactive or rejects.
   */
  buildHeadlessCommand(task: CodingCliTask): CodingCliCommand | null;
  buildInteractiveCommand(session: CodingCliSessionConfig): CodingCliCommand;
  formatInitialPrompt(task: CodingCliTask): string;
  formatFollowupMessage(message: string): string;
  parseOutputDelta(chunk: string, ctx: ParseContext): CodingCliParsedEvent[];
  parseFinalResult(output: string): CodingCliResult | null;
  detectApprovalRequest(output: string, hookEvent?: HookEvent): CodingCliApprovalRequest | null;
  respondToApproval(request: CodingCliApprovalRequest, decision: ApprovalDecision): CodingCliInput;
  setupHookBridge?(ctx: HookBridgeContext): Promise<HookBridgeSetupResult>;
  cleanup?(sessionId: string): Promise<void>;
}

// ── Controller-level config (config/codingCli) ──────────────────────────

export const CodingCliProviderConfigSchema = z.object({
  enabled: z.boolean().default(true),
  binaryPath: z.string().optional(),
  /** Operator-explicit override; the runner never auto-sets this. */
  allowDangerousSkipPermissions: z.boolean().default(false),
  /** GitHub Copilot only — fall back to legacy `gh copilot` wrapper. */
  legacyGhCopilotFallback: z.boolean().default(true),
  hookBridge: z
    .object({
      enabled: z.boolean().default(true),
      mode: HookBridgeModeSchema.default('hybrid'),
    })
    .default(() => ({ enabled: true, mode: 'hybrid' as const })),
});
export type CodingCliProviderConfig = z.infer<typeof CodingCliProviderConfigSchema>;

const PROVIDER_DEFAULT = {
  enabled: true,
  allowDangerousSkipPermissions: false,
  legacyGhCopilotFallback: true,
  hookBridge: { enabled: true, mode: 'hybrid' as const },
};

export const CodingCliConfigSchema = z.object({
  enabled: z.boolean().default(false),
  defaultProvider: z.enum(['auto', ...PROVIDER_IDS]).default('auto'),
  mode: z.enum(['headless', 'interactive', 'auto']).default('auto'),
  timeoutMs: z.number().int().positive().default(15 * 60 * 1000),
  idleTimeoutMs: z.number().int().positive().default(2 * 60 * 1000),
  maxOutputBytes: z.number().int().positive().default(4 * 1024 * 1024),
  providers: z
    .object({
      claudeCode: CodingCliProviderConfigSchema.default(() => ({ ...PROVIDER_DEFAULT })),
      githubCopilot: CodingCliProviderConfigSchema.default(() => ({ ...PROVIDER_DEFAULT })),
    })
    .default(() => ({
      claudeCode: { ...PROVIDER_DEFAULT },
      githubCopilot: { ...PROVIDER_DEFAULT },
    })),
  permissions: ApprovalPolicySchema.default(() => ApprovalPolicySchema.parse({})),
});
export type CodingCliConfig = z.infer<typeof CodingCliConfigSchema>;

// ── Persisted session record (DB row) ───────────────────────────────────

export interface CodingCliSessionRecord {
  id: string;
  taskId: string;
  sessionId: string | null;
  providerId: CodingCliProviderId;
  binaryPath: string;
  binaryVersion: string | null;
  capabilities: CodingCliCapabilities;
  cwd: string;
  pid: number | null;
  state: CodingCliSessionState;
  startedAt: number;
  updatedAt: number;
  endedAt: number | null;
  lastOutputAt: number | null;
  lastHookAt: number | null;
  transcriptPath: string | null;
  eventLogPath: string | null;
  filesChanged: string[];
  commandsRequested: string[];
  finalResult: CodingCliResult | null;
  /** Final wall-clock-aligned summary the controller writes on terminal state. */
  rawMeta: Record<string, unknown>;
}
