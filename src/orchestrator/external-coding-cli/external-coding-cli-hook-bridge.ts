/**
 * Hook bridge — provider-neutral ingestion of out-of-band hook events.
 *
 * Three modes:
 *   - native:  the provider has a real hook system (e.g. Claude Code's
 *              settings.json hooks). Adapter writes a small bridge config
 *              and arranges for the provider to invoke it. Bridge tails
 *              the resulting JSONL log.
 *   - wrapper: no native hooks. We synthesize hook-shaped events from
 *              stdout/stderr parsing + git/fs diff, and write them to the
 *              same JSONL log. Wrapper events are tagged so consumers know
 *              the provenance is heuristic, not deterministic (A5).
 *   - hybrid:  both — native preferred, wrapper fills gaps. The default.
 *   - off:     no hook events at all (degraded mode).
 *
 * The bridge is append-only and tolerates concurrent writers (the native
 * shell hook + wrapper). Each line is a self-contained JSON object.
 *
 * Optional filesystem watcher: in `wrapper` and `hybrid` modes the bridge
 * can start a chokidar watch over the workspace cwd to emit live
 * `file_changed` wrapper events as the CLI writes/edits/deletes files.
 * This gives near-real-time UI feedback even when the provider has no
 * native hook protocol (e.g. GitHub Copilot today). Watcher is opt-in via
 * `attachWorkspaceWatcher()` to keep tests deterministic.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import { HookEventSchema, type HookEvent, type HookBridgeMode, type CodingCliProviderId } from './types.ts';

export interface HookSinkOptions {
  path: string;
  /** Per-line cap to bound memory in case a hook blob is unbounded. */
  maxLineBytes?: number;
}

export class HookSink {
  private readonly logPath: string;
  private readonly maxLineBytes: number;
  private readPosition = 0;

  constructor(opts: HookSinkOptions) {
    this.logPath = opts.path;
    this.maxLineBytes = opts.maxLineBytes ?? 256 * 1024;
    this.ensureDir();
    // Truncate on init so a stale log from a previous session can't leak.
    fs.writeFileSync(this.logPath, '');
  }

  private ensureDir(): void {
    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
  }

  /** Synchronous append — used by wrapper-emitted events on the hot path. */
  appendSync(event: HookEvent): void {
    const validated = HookEventSchema.parse(event);
    const line = JSON.stringify(validated);
    if (line.length > this.maxLineBytes) {
      // Drop oversized payload but keep the event metadata for observability.
      const trimmed: HookEvent = { ...validated, raw: { _truncated: true, byteCount: line.length } };
      fs.appendFileSync(this.logPath, `${JSON.stringify(trimmed)}\n`);
      return;
    }
    fs.appendFileSync(this.logPath, `${line}\n`);
  }

  /**
   * Drain new events since the last call. The reader keeps a byte cursor
   * in-process — fine because the sink is per-session and single-threaded
   * on the runner side.
   */
  drain(): HookEvent[] {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(this.logPath);
    } catch {
      return [];
    }
    if (stat.size <= this.readPosition) return [];
    const fd = fs.openSync(this.logPath, 'r');
    try {
      const length = stat.size - this.readPosition;
      const buf = Buffer.alloc(length);
      fs.readSync(fd, buf, 0, length, this.readPosition);
      this.readPosition = stat.size;
      return this.parseChunk(buf.toString('utf8'));
    } finally {
      fs.closeSync(fd);
    }
  }

  private parseChunk(chunk: string): HookEvent[] {
    const out: HookEvent[] = [];
    for (const rawLine of chunk.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        const validation = HookEventSchema.safeParse(parsed);
        if (validation.success) out.push(validation.data);
      } catch {
        // Skip — malformed line, do not block the rest of the stream.
      }
    }
    return out;
  }

  path(): string {
    return this.logPath;
  }

  close(): void {
    // No-op: appendFileSync uses ephemeral fd handles.
  }
}

// ── Wrapper hook synthesis ──────────────────────────────────────────────

export interface WrapperEventInput {
  providerId: HookEvent['providerId'];
  taskId: string;
  codingCliSessionId: string;
  cwd: string;
  hookName: string;
  eventType: string;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: unknown;
  files?: string[];
  raw?: unknown;
  timestamp?: number;
}

export function synthWrapperEvent(input: WrapperEventInput): HookEvent {
  return HookEventSchema.parse({
    providerId: input.providerId,
    codingCliSessionId: input.codingCliSessionId,
    taskId: input.taskId,
    hookName: input.hookName,
    eventType: input.eventType,
    toolName: input.toolName,
    toolInput: input.toolInput,
    toolResult: input.toolResult,
    cwd: input.cwd,
    files: input.files,
    timestamp: input.timestamp ?? Date.now(),
    raw: input.raw ?? { _wrapperSynthesized: true },
  });
}

// ── Bridge controller ───────────────────────────────────────────────────

export interface HookBridgeReport {
  mode: HookBridgeMode;
  /** Always populated — even native mode uses the JSONL sink. */
  sinkPath: string;
  /** Number of native events ingested since session start. */
  nativeCount: number;
  /** Number of wrapper-synthesized events. */
  wrapperCount: number;
}

export interface WorkspaceWatcherContext {
  providerId: CodingCliProviderId;
  taskId: string;
  codingCliSessionId: string;
  cwd: string;
  /**
   * Optional ignore patterns. Matched against absolute path. Default
   * blocks `.git`, `node_modules`, `.vinyan` to keep noise out — those
   * paths exist in essentially every workspace and aren't where the CLI
   * is editing user code.
   */
  ignored?: (string | RegExp)[];
  /**
   * Throttle: minimum gap (ms) between two wrapper events for the same
   * path. Prevents an editor's atomic-write dance from emitting 5 events
   * for one save. Default 250 ms.
   */
  perPathThrottleMs?: number;
}

export class HookBridge {
  private readonly sink: HookSink;
  private readonly mode: HookBridgeMode;
  private nativeCount = 0;
  private wrapperCount = 0;
  private watcher: FSWatcher | null = null;
  private watchContext: WorkspaceWatcherContext | null = null;
  private readonly lastEmitByPath = new Map<string, number>();

  constructor(opts: { sinkPath: string; mode: HookBridgeMode }) {
    this.sink = new HookSink({ path: opts.sinkPath });
    this.mode = opts.mode;
  }

  /**
   * Start a chokidar watch over `ctx.cwd` and emit synthesized wrapper
   * events on file create/modify/delete. No-op when mode is `native` or
   * `off`. Returns true when the watcher was started.
   */
  attachWorkspaceWatcher(ctx: WorkspaceWatcherContext): boolean {
    if (this.mode === 'native' || this.mode === 'off') return false;
    if (this.watcher) return false;
    const ignored = ctx.ignored ?? [
      /(^|[/\\])\.git([/\\]|$)/,
      /(^|[/\\])node_modules([/\\]|$)/,
      /(^|[/\\])\.vinyan([/\\]|$)/,
      /(^|[/\\])\.bun([/\\]|$)/,
      /(^|[/\\])dist([/\\]|$)/,
    ];
    this.watchContext = { ...ctx, ignored };
    try {
      this.watcher = chokidar.watch(ctx.cwd, {
        ignored,
        ignoreInitial: true,
        persistent: true,
        // Wait for the file to settle before emitting — editors do
        // atomic-replace dances that can fire 3+ events per save.
        awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 30 },
        // No symlink chasing; matches TranscriptReader's stance.
        followSymlinks: false,
      });
      this.watcher.on('add', (p) => this.handleWatchEvent('created', p));
      this.watcher.on('change', (p) => this.handleWatchEvent('modified', p));
      this.watcher.on('unlink', (p) => this.handleWatchEvent('deleted', p));
      this.watcher.on('error', () => {
        // Best-effort — a watcher error must not crash the controller.
      });
      return true;
    } catch {
      // Some sandboxed environments (CI without inotify) reject chokidar.
      // Degrade silently — the post-run git diff still catches changes.
      this.watcher = null;
      this.watchContext = null;
      return false;
    }
  }

  private handleWatchEvent(changeType: 'created' | 'modified' | 'deleted', filePath: string): void {
    const ctx = this.watchContext;
    if (!ctx) return;
    const throttleMs = ctx.perPathThrottleMs ?? 250;
    const now = Date.now();
    const last = this.lastEmitByPath.get(filePath);
    if (last !== undefined && now - last < throttleMs) return;
    this.lastEmitByPath.set(filePath, now);
    this.emitWrapper({
      providerId: ctx.providerId,
      taskId: ctx.taskId,
      codingCliSessionId: ctx.codingCliSessionId,
      cwd: ctx.cwd,
      hookName: 'workspace-watcher',
      eventType: 'file_changed',
      files: [filePath],
      raw: { changeType, _wrapperSynthesized: true, source: 'chokidar' },
      timestamp: now,
    });
  }

  /** Drain pending native-source events from the sink. */
  drainNative(): HookEvent[] {
    if (this.mode === 'off') return [];
    const events = this.sink.drain();
    this.nativeCount += events.length;
    return events;
  }

  /** Synthesize a wrapper-side event and persist it to the same sink. */
  emitWrapper(event: WrapperEventInput): HookEvent {
    if (this.mode === 'off' || this.mode === 'native') {
      // In native-only or off mode, wrapper events are still useful for
      // replay — we persist but tag them clearly. This is intentional
      // (A8 traceability over selective omission).
    }
    const synthesized = synthWrapperEvent(event);
    this.sink.appendSync(synthesized);
    this.wrapperCount += 1;
    return synthesized;
  }

  report(): HookBridgeReport {
    return {
      mode: this.mode,
      sinkPath: this.sink.path(),
      nativeCount: this.nativeCount,
      wrapperCount: this.wrapperCount,
    };
  }

  async close(): Promise<void> {
    if (this.watcher) {
      try { await this.watcher.close(); } catch {}
      this.watcher = null;
      this.watchContext = null;
    }
    this.lastEmitByPath.clear();
    this.sink.close();
  }
}
