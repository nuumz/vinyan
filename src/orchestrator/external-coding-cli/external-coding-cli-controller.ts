/**
 * ExternalCodingCliController — top-level entry point for the external
 * coding CLI subsystem. It:
 *
 *   - Holds the registry of provider adapters.
 *   - Runs detection on demand and caches the result.
 *   - Routes tasks to providers via the capability matrix (caller can
 *     override). Limited variants are NEVER auto-routed for code editing.
 *   - Constructs a session per task, wires the bridges, and emits bus
 *     events.
 *   - After CLI completion, runs Vinyan-side verification BEFORE marking
 *     the session as `completed`. If verification fails, the session is
 *     marked `failed` and prediction error is recorded.
 *   - Persists session records (when a store is provided).
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { VinyanBus } from '../../core/bus.ts';
import type { ApprovalGate } from '../approval-gate.ts';
import { CodingCliApprovalBridge } from './external-coding-cli-approval-bridge.ts';
import { HookBridge } from './external-coding-cli-hook-bridge.ts';
import { CodingCliRunner } from './external-coding-cli-runner.ts';
import { CodingCliSession } from './external-coding-cli-session.ts';
import { CodingCliVerifier } from './external-coding-cli-verifier.ts';
import { ProviderDetectionRegistry } from './providers/provider-detection.ts';
import {
  type CodingCliCapabilities,
  type CodingCliConfig,
  type CodingCliDetectionResult,
  type CodingCliProviderAdapter,
  type CodingCliProviderId,
  type CodingCliResult,
  type CodingCliSessionRecord,
  type CodingCliTask,
  CodingCliTaskSchema,
  isTerminalState,
} from './types.ts';

export interface CodingCliSessionStore {
  insert(record: CodingCliSessionRecord): void;
  update(record: CodingCliSessionRecord): void;
  list(): CodingCliSessionRecord[];
  get(id: string): CodingCliSessionRecord | null;
  appendEvent(sessionId: string, eventType: string, payload: unknown, ts: number): void;
  recordApproval(record: {
    id: string;
    sessionId: string;
    taskId: string;
    requestId: string;
    command: string;
    reason: string;
    policyDecision: string;
    humanDecision: string | null;
    decidedBy: string | null;
    decidedAt: number | null;
    requestedAt: number;
    rawJson: string;
  }): void;
  recordDecision(record: {
    id: string;
    sessionId: string;
    taskId: string;
    decision: string;
    rationale: string;
    alternativesJson: string;
    ts: number;
  }): void;
}

export interface ControllerOptions {
  bus: VinyanBus;
  approvalGate: ApprovalGate;
  config: CodingCliConfig;
  adapters: ReadonlyArray<CodingCliProviderAdapter>;
  /** Optional persistence layer. Tests typically omit. */
  store?: CodingCliSessionStore;
  /** Build a verifier per task. If omitted, a default (git-diff only) is used. */
  buildVerifier?: (task: CodingCliTask) => CodingCliVerifier;
}

export interface RouteDecision {
  providerId: CodingCliProviderId;
  reason: string;
}

export class ExternalCodingCliController {
  private readonly options: ControllerOptions;
  private readonly adapters: Map<CodingCliProviderId, CodingCliProviderAdapter>;
  private readonly detection: ProviderDetectionRegistry;
  private readonly sessions = new Map<string, CodingCliSession>();
  private readonly hookBridges = new Map<string, HookBridge>();
  private readonly approvalBridge: CodingCliApprovalBridge;

  constructor(options: ControllerOptions) {
    this.options = options;
    this.adapters = new Map(options.adapters.map((a) => [a.id, a]));
    this.detection = new ProviderDetectionRegistry();
    this.approvalBridge = new CodingCliApprovalBridge({
      bus: options.bus,
      approvalGate: options.approvalGate,
      policy: options.config.permissions,
    });
  }

  // ── Detection ─────────────────────────────────────────────────────────

  async detectProviders(forceRefresh = false): Promise<CodingCliDetectionResult[]> {
    return this.detection.detectAll([...this.adapters.values()], { forceRefresh });
  }

  /** Read-only view of cached detections. */
  getDetections(): CodingCliDetectionResult[] {
    const out: CodingCliDetectionResult[] = [];
    for (const adapter of this.adapters.values()) {
      const detection = this.detection.get(adapter.id);
      if (detection) out.push(detection);
    }
    return out;
  }

  // ── Routing ───────────────────────────────────────────────────────────

  /**
   * Choose a provider based on capability requirements. Limited variants
   * are NEVER auto-selected.
   */
  pickProvider(
    requirements: { needsHeadless?: boolean; needsInteractive?: boolean; needsHooks?: boolean } = {},
    preferred?: CodingCliProviderId,
  ): RouteDecision | null {
    const detections = this.getDetections();
    const eligible = [...detections].filter((d) => d.available && d.variant !== 'limited');
    // Falsifiable trigger from `external-coding-cli-pty-adapter.ts`:
    // never route an `interactive` request to a provider that lacks a
    // stream protocol — pipes-without-isatty + interactive REPL = silent
    // hang. The pipe wrapper is honest about this; the controller
    // enforces it.
    const filtered = requirements.needsInteractive
      ? eligible.filter((d) => d.capabilities.interactive && d.capabilities.streamProtocol)
      : requirements.needsHeadless
      ? eligible.filter((d) => d.capabilities.headless)
      : eligible;
    const ranked = filtered.sort((a, b) => this.score(b, requirements) - this.score(a, requirements));
    if (preferred) {
      const explicit = ranked.find((d) => d.providerId === preferred);
      if (explicit) {
        return { providerId: explicit.providerId, reason: 'explicit operator preference' };
      }
    }
    const top = ranked[0];
    if (!top) return null;
    return { providerId: top.providerId, reason: this.explainScore(top, requirements) };
  }

  private score(d: CodingCliDetectionResult, req: { needsHeadless?: boolean; needsInteractive?: boolean; needsHooks?: boolean }): number {
    let s = 0;
    if (req.needsHeadless && d.capabilities.headless) s += 5;
    if (req.needsInteractive && d.capabilities.interactive) s += 5;
    if (req.needsHooks && d.capabilities.nativeHooks) s += 4;
    s += d.capabilities.headless ? 1 : 0;
    s += d.capabilities.interactive ? 1 : 0;
    s += d.capabilities.nativeHooks ? 2 : 0;
    s += d.capabilities.jsonOutput ? 1 : 0;
    s += d.capabilities.toolEvents ? 1 : 0;
    return s;
  }

  private explainScore(d: CodingCliDetectionResult, req: { needsHeadless?: boolean; needsInteractive?: boolean; needsHooks?: boolean }): string {
    const parts: string[] = [];
    if (req.needsHeadless && d.capabilities.headless) parts.push('supports headless');
    if (req.needsInteractive && d.capabilities.interactive) parts.push('supports interactive');
    if (req.needsHooks && d.capabilities.nativeHooks) parts.push('supports native hooks');
    if (parts.length === 0) parts.push('best available capability score');
    return parts.join(', ');
  }

  // ── Session creation ──────────────────────────────────────────────────

  async createSession(taskInput: CodingCliTask, providerId?: CodingCliProviderId): Promise<CodingCliSession> {
    const task = CodingCliTaskSchema.parse(taskInput);
    const targetProvider = providerId ?? task.providerId ?? this.pickProvider({ needsInteractive: task.mode === 'interactive', needsHeadless: task.mode === 'headless' })?.providerId;
    if (!targetProvider) {
      throw new Error('no available coding-cli provider for task');
    }
    const adapter = this.adapters.get(targetProvider);
    if (!adapter) throw new Error(`adapter not registered: ${targetProvider}`);
    const detection = this.detection.get(targetProvider) ?? (await adapter.detect());
    if (!detection.available) {
      const session = this.makeUnsupportedSession(task, adapter, detection);
      return session;
    }
    if (detection.variant === 'limited') {
      const session = this.makeUnsupportedSession(task, adapter, detection, 'limited variant');
      return session;
    }
    // Falsifiable trigger guard: interactive requested but provider lacks
    // a stream protocol. Refuse rather than spawn a TTY-only CLI over pipes.
    if (
      task.mode === 'interactive' &&
      detection.capabilities.interactive &&
      !detection.capabilities.streamProtocol
    ) {
      return this.makeUnsupportedSession(
        task,
        adapter,
        detection,
        'interactive routing requires streamProtocol; provider has interactive=true but streamProtocol=false (would hang on isatty checks)',
      );
    }

    // Hook bridge — per-session sink under tmpdir.
    const sessionDir = this.makeSessionDir(task.taskId);
    const sinkPath = path.join(sessionDir, 'hook-events.jsonl');
    const hookBridge = new HookBridge({
      sinkPath,
      mode: this.options.config.providers[adapter.id === 'claude-code' ? 'claudeCode' : 'githubCopilot']?.hookBridge.mode ?? 'hybrid',
    });

    if (adapter.setupHookBridge) {
      const setup = await adapter.setupHookBridge({
        providerId: adapter.id,
        taskId: task.taskId,
        codingCliSessionId: this.makeSessionId(task.taskId, adapter.id),
        cwd: task.cwd,
        eventLogPath: sinkPath,
        configDir: sessionDir,
      });
      void setup; // teardown is tracked elsewhere; for v1 we leak temp until session end.
    }

    // Live wrapper-mode workspace watcher — gives the UI real-time
    // file_changed events for providers (e.g. Copilot today) that have no
    // native hook protocol. No-op in `native` and `off` modes; falls back
    // silently in CI sandboxes without inotify.
    hookBridge.attachWorkspaceWatcher({
      providerId: adapter.id,
      taskId: task.taskId,
      codingCliSessionId: this.makeSessionId(task.taskId, adapter.id),
      cwd: task.cwd,
    });

    const runner = new CodingCliRunner(adapter);
    const sessionId = this.makeSessionId(task.taskId, adapter.id);
    const session = new CodingCliSession(sessionId, task, {
      bus: this.options.bus,
      adapter,
      runner,
      approvalBridge: this.approvalBridge,
      hookBridge,
    });
    this.sessions.set(sessionId, session);
    this.hookBridges.set(sessionId, hookBridge);
    session.emitCreated(detection.binaryPath ?? '(unknown)', detection.version);

    if (this.options.store) {
      this.options.store.insert(this.snapshotRecord(session, detection));
    }
    return session;
  }

  // ── Headless run with verification ────────────────────────────────────

  async runHeadless(taskInput: CodingCliTask, providerId?: CodingCliProviderId): Promise<{
    session: CodingCliSession;
    claim: CodingCliResult | null;
    verification: ReturnType<CodingCliVerifier['verify']> extends Promise<infer R> ? R : never;
  }> {
    const session = await this.createSession({ ...taskInput, mode: 'headless' }, providerId);
    if (session.state() === 'unsupported-capability') {
      return { session, claim: null, verification: { passed: false, oracleVerdicts: [], predictionError: false, reason: 'provider unsupported' } as never };
    }
    const headless = await session.runHeadless();
    const verifier = this.options.buildVerifier
      ? this.options.buildVerifier(session.task)
      : new CodingCliVerifier({ cwd: session.task.cwd });
    // Fallback chain for the final claim:
    //   1. headless.result        → parsed CODING_CLI_RESULT (literal or
    //                                inside stream-json result envelope)
    //   2. synthesizedClaim(...)  → when the CLI exited cleanly but did
    //                                NOT emit the envelope at all (most
    //                                Claude Code interactions). A9 graceful
    //                                degradation; Vinyan's verifier still
    //                                runs and has final say (A1).
    //   3. fail-with-reason       → process crashed, killed, or produced
    //                                no usable output.
    let claim = headless.result;
    if (!claim) {
      const synthesized = synthesizeClaimFromSession(session, headless);
      if (synthesized) {
        claim = synthesized;
        this.options.bus.emit('coding-cli:result_reported', {
          taskId: session.task.taskId,
          sessionId: session.task.sessionId,
          codingCliSessionId: session.id,
          providerId: session.adapterId as CodingCliProviderId,
          state: session.state(),
          ts: Date.now(),
          claim,
        });
      }
    }
    if (!claim) {
      session.finalize('failed', 'no result envelope emitted and no usable session output to synthesize from');
      return { session, claim, verification: { passed: false, oracleVerdicts: [], predictionError: false, reason: 'no result' } as never };
    }
    const baseEvent = {
      taskId: session.task.taskId,
      sessionId: session.task.sessionId,
      codingCliSessionId: session.id,
      providerId: session.adapterId as CodingCliProviderId,
      state: session.state(),
      ts: Date.now(),
    } as const;
    this.options.bus.emit('coding-cli:verification_started', { ...baseEvent, changedFiles: claim.changedFiles });
    const verification = await verifier.verify(claim);
    this.options.bus.emit('coding-cli:verification_completed', {
      ...baseEvent,
      ts: Date.now(),
      passed: verification.passed,
      oracleVerdicts: verification.oracleVerdicts,
      testResults: verification.testResults,
      predictionError: verification.predictionError
        ? { claimed: claim.verification.claimedPassed, actual: verification.passed, reason: verification.reason ?? 'prediction error' }
        : undefined,
    });
    if (verification.passed) session.finalize('completed', 'verification passed');
    else session.finalize('failed', verification.reason ?? 'verification failed');
    if (this.options.store) {
      this.options.store.update(this.snapshotRecord(session, this.detection.get(session.adapterId as CodingCliProviderId)));
    }
    return { session, claim, verification };
  }

  // ── Lookup / control ──────────────────────────────────────────────────

  getSession(id: string): CodingCliSession | undefined {
    return this.sessions.get(id);
  }

  listSessions(): CodingCliSession[] {
    return [...this.sessions.values()];
  }

  async cancelSession(id: string, reason?: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    await session.cancel(reason);
    this.approvalBridge.cancelPendingForSession(id);
    if (this.options.store) {
      this.options.store.update(this.snapshotRecord(session, this.detection.get(session.adapterId as CodingCliProviderId)));
    }
    return true;
  }

  resolveApproval(taskId: string, requestId: string, decision: 'approved' | 'rejected'): boolean {
    return this.approvalBridge.resolveExternal(taskId, requestId, decision);
  }

  /** Dispose of all sessions — used during orchestrator shutdown. */
  async dispose(): Promise<void> {
    for (const id of [...this.sessions.keys()]) {
      await this.cancelSession(id, 'controller disposed');
    }
    await Promise.all([...this.hookBridges.values()].map((b) => b.close()));
    this.sessions.clear();
    this.hookBridges.clear();
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  private makeUnsupportedSession(
    task: CodingCliTask,
    adapter: CodingCliProviderAdapter,
    detection: CodingCliDetectionResult,
    reason: string = 'provider not available',
  ): CodingCliSession {
    const sessionId = this.makeSessionId(task.taskId, adapter.id);
    const sinkPath = path.join(this.makeSessionDir(task.taskId), 'hook-events.jsonl');
    const hookBridge = new HookBridge({ sinkPath, mode: 'off' });
    const runner = new CodingCliRunner(adapter);
    const session = new CodingCliSession(sessionId, task, {
      bus: this.options.bus,
      adapter,
      runner,
      approvalBridge: this.approvalBridge,
      hookBridge,
    });
    this.sessions.set(sessionId, session);
    this.hookBridges.set(sessionId, hookBridge);
    session.emitCreated(detection.binaryPath ?? '(unknown)', detection.version);
    session.finalize('unsupported-capability', reason);
    return session;
  }

  private makeSessionId(taskId: string, providerId: CodingCliProviderId): string {
    return `coding-cli-${providerId}-${taskId}-${Date.now()}`;
  }

  private makeSessionDir(taskId: string): string {
    const dir = path.join(os.tmpdir(), 'vinyan-coding-cli', taskId);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private snapshotRecord(session: CodingCliSession, detection?: CodingCliDetectionResult): CodingCliSessionRecord {
    const timings = session.timingsSnapshot();
    const capabilities: CodingCliCapabilities = detection?.capabilities ?? session.capabilities;
    return {
      id: session.id,
      taskId: session.task.taskId,
      sessionId: session.task.sessionId ?? null,
      providerId: session.adapterId as CodingCliProviderId,
      binaryPath: detection?.binaryPath ?? '(unknown)',
      binaryVersion: detection?.version ?? null,
      capabilities,
      cwd: session.task.cwd,
      pid: session.pidOrNull(),
      state: session.state(),
      startedAt: timings.startedAt ?? timings.createdAt,
      updatedAt: Date.now(),
      endedAt: isTerminalState(session.state()) ? timings.endedAt : null,
      lastOutputAt: timings.lastOutputAt,
      lastHookAt: timings.lastHookAt,
      transcriptPath: null,
      eventLogPath: this.hookBridges.get(session.id)?.report().sinkPath ?? null,
      filesChanged: session.changedFiles(),
      commandsRequested: session.commands(),
      finalResult: session.result(),
      rawMeta: { providerSessionId: session.providerSessionIdOrNull() },
    };
  }
}

// ── Claim synthesis ─────────────────────────────────────────────────────

/**
 * Synthesize a partial CodingCliResult from session state when the CLI
 * exits cleanly but does not emit a structured CODING_CLI_RESULT envelope.
 *
 * This is a graceful-degradation path (A9). Most Claude Code interactions
 * do not naturally end with a fenced "<CODING_CLI_RESULT>{...}</...>"
 * block — the model is trained to be conversational, not to emit
 * machine-readable envelopes on demand. Failing every such session as
 * "no result envelope emitted" makes the system unusable in practice.
 *
 * Synthesis rules:
 *   - status: 'partial' (NEVER 'completed' — only Vinyan's verifier can
 *     promote to completed via A1).
 *   - claimedPassed: false (we cannot infer pass/fail without the
 *     envelope; let the verifier decide).
 *   - changedFiles: from session.changedFiles() — populated by Edit/Write
 *     tool events + workspace watcher.
 *   - commandsRun: from session.commands() — populated by Bash/shell tool
 *     events.
 *   - summary: extracted from the last stream-json `result` line's
 *     `.result` text (truncated). Falls back to a generic message.
 *
 * Returns null when there is genuinely nothing to synthesize from
 * (process crashed before producing any output / non-zero exit code).
 */
function synthesizeClaimFromSession(
  session: CodingCliSession,
  headless: { stdout: string; stderr: string; exitCode: number | null },
): CodingCliResult | null {
  // Crashed / killed / non-zero exit → no synthesis. The runner already
  // surfaced the failure honestly; we should not invent a partial claim.
  if (headless.exitCode !== 0 && headless.exitCode !== null) return null;

  const summary = extractFinalAssistantText(headless.stdout);
  const changedFiles = session.changedFiles();
  const commandsRun = session.commands();

  // If we have absolutely no signal — no summary text, no file changes,
  // no commands — there is nothing to verify against. Don't synthesize a
  // ghost claim; let the controller's "no result" path fire.
  if (!summary && changedFiles.length === 0 && commandsRun.length === 0) {
    return null;
  }

  return {
    status: 'partial',
    providerId: session.adapterId as CodingCliProviderId,
    summary: summary || '(CLI did not emit a structured result envelope; synthesized claim from observed activity)',
    changedFiles,
    commandsRun,
    testsRun: [],
    decisions: [],
    verification: { claimedPassed: false, details: 'synthesized — CLI did not self-report verification status' },
    blockers: [],
    requiresHumanReview: true,
  };
}

/**
 * Best-effort extraction of the last assistant text from a stream-json
 * stdout buffer. Walks newest-to-oldest looking for the SDK's final
 * `{"type":"result","result":"<text>",...}` envelope; falls back to
 * concatenating all `assistant` message text deltas if no result line
 * was emitted (rare — the SDK always emits one on clean exit).
 *
 * Truncates to 4 KiB so a synthesized summary doesn't blow up the
 * verifier or the UI's result card.
 */
function extractFinalAssistantText(stdout: string): string {
  const MAX = 4 * 1024;
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let parsed: { type?: string; result?: unknown } | null = null;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || parsed.type !== 'result') continue;
    const text = typeof parsed.result === 'string' ? parsed.result : '';
    if (text) return text.length > MAX ? `${text.slice(0, MAX)}…` : text;
  }
  // Fallback: concatenate assistant text deltas. Emit empty if no
  // assistant content was found at all.
  const collected: string[] = [];
  let total = 0;
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    let parsed: { type?: string; message?: { content?: unknown[] } } | null = null;
    try {
      parsed = JSON.parse(t);
    } catch {
      continue;
    }
    if (!parsed || parsed.type !== 'assistant') continue;
    const content = parsed.message?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (item && typeof item === 'object' && (item as { type?: string }).type === 'text') {
        const text = String((item as { text?: unknown }).text ?? '');
        if (!text) continue;
        collected.push(text);
        total += text.length;
        if (total >= MAX) break;
      }
    }
    if (total >= MAX) break;
  }
  const joined = collected.join('');
  return joined.length > MAX ? `${joined.slice(0, MAX)}…` : joined;
}
