/**
 * CLI: vinyan serve supervisor.
 *
 * Spawns the actual server as a child subprocess. Provides two
 * self-healing capabilities:
 *
 *   1. Crash recovery — if the child exits non-zero (uncaught error,
 *      OOM, native crash), respawn with capped exponential backoff.
 *   2. Hot reload (opt-in via --watch) — watch the source tree and
 *      trigger a graceful child restart when a .ts file changes. This
 *      lets Vinyan evolve itself: regenerate its own code, save, and
 *      see the running server pick up the change without a manual
 *      restart.
 *
 * The parent:
 *   - Forwards SIGTERM/SIGINT to the child and exits after it does
 *   - Respawns on crash with capped exponential backoff
 *   - Resets the backoff counter once the child has been healthy > 60s
 *   - When --watch: debounces file change events (200ms) and sends
 *     SIGTERM to the child; the respawn loop brings up a fresh one.
 *
 * The child runs when VINYAN_SUPERVISED=1 is set in its env.
 */

import { watch, type FSWatcher } from 'chokidar';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'path';

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 30_000;
const HEALTHY_THRESHOLD_MS = 60_000;
const MAX_CONSECUTIVE_CRASHES = 20;
const WATCH_DEBOUNCE_MS = 200;
/** Fast-fatal threshold: if the child dies in < this on its first attempt, we assume a config/port error and exit instead of respawn-looping. */
const FAST_FATAL_MS = 2_000;
/** Exit code the child uses to signal "startup-fatal, do not retry" (matches serve.ts EXIT_CODE_STARTUP_FATAL). */
const EXIT_CODE_STARTUP_FATAL = 78;

/** Paths (relative to workspace) to watch for hot reload. */
const WATCH_PATHS = ['src', 'vinyan.json'];
/** File-path predicate: only .ts / vinyan.json, skip tests and noise dirs. */
function shouldIgnore(absPath: string): boolean {
  if (/node_modules|\.vinyan|\/dist\/|\/\.git\//.test(absPath)) return true;
  if (/\.(test|spec)\.ts$/.test(absPath)) return true;
  // Only react to .ts and vinyan.json (directory entries pass through)
  if (absPath.endsWith('.ts')) return false;
  if (absPath.endsWith('vinyan.json')) return false;
  // Allow directories (chokidar needs to recurse)
  // We can't stat here synchronously cheaply; chokidar passes dirs too.
  // If it looks like a file with a different extension, ignore it.
  const base = absPath.split('/').pop() ?? '';
  if (base.includes('.')) return true;
  return false;
}

/** How long to wait for graceful child shutdown before SIGKILL escalation. */
const FORCE_KILL_MS = 5_000;
/** Hard deadline after first signal — supervisor itself exits no matter what. */
const SUPERVISOR_FORCE_EXIT_MS = 10_000;

export async function superviseServe(workspace: string, originalArgv: string[]): Promise<void> {
  // Strip the node/bun executable path; keep the script + args
  const [, scriptPath, ...rest] = originalArgv;
  if (!scriptPath) {
    throw new Error('superviseServe: missing script path in argv');
  }
  const bunExec = process.execPath;
  const watchMode = rest.includes('--watch');

  let crashCount = 0;
  let backoff = INITIAL_BACKOFF_MS;
  let stopping = false;
  let currentChild: ChildProcess | null = null;
  let reloadRequested = false;
  let watcher: FSWatcher | null = null;

  // ── PID file: stale-detect a previous supervisor + persist our PID ──
  const pidFilePath = join(workspace, '.vinyan', 'supervisor.pid');
  const stalePid = readSupervisorPid(pidFilePath);
  if (stalePid !== null && stalePid !== process.pid) {
    if (isProcessAlive(stalePid)) {
      console.error(`[vinyan-supervisor] Another supervisor is running (pid ${stalePid}).`);
      console.error(`[vinyan-supervisor] Stop it first: kill ${stalePid}   or remove ${pidFilePath} if stale.`);
      process.exit(EXIT_CODE_STARTUP_FATAL);
    }
    // Stale — remove and continue.
    try { unlinkSync(pidFilePath); } catch { /* best-effort */ }
  }
  writeSupervisorPid(pidFilePath);

  // ── Last-resort sync cleanup on any exit path ──
  //   - Remove our PID file.
  //   - SIGKILL the current child so it cannot outlive us (zombie
  //     guarantee: if the supervisor process dies for ANY reason,
  //     the child goes with it).
  process.on('exit', () => {
    try { unlinkSync(pidFilePath); } catch { /* already removed */ }
    const c = currentChild;
    if (c && !c.killed) {
      try { c.kill('SIGKILL'); } catch { /* already gone */ }
    }
  });

  // ── Signal handling (registered ONCE, outside the respawn loop) ──
  //
  // Previously `installSignalForwarding(child)` was called per loop
  // iteration, adding a fresh SIGINT/SIGTERM listener on every child
  // respawn and leaking handlers across long uptimes. Hoisting out of
  // the loop keeps the listener count at exactly 1/signal and lets us
  // implement proper escalation (SIGKILL on 2nd signal or after timeout).
  let sigintCount = 0;
  const handleStop = (signal: 'SIGTERM' | 'SIGINT' | 'SIGHUP') => {
    stopping = true;
    sigintCount++;
    const child = currentChild;
    if (!child || child.killed) {
      // No live child — just exit. Shouldn't normally happen because
      // supervisor awaits child exit inside the respawn loop, but
      // handle defensively.
      process.exit(sigintCount >= 2 ? 1 : 0);
    }

    if (sigintCount >= 2) {
      // Second signal = user is insistent. Hard-kill the child and
      // exit immediately so the user is not stranded.
      console.error('[vinyan-supervisor] Second signal received — SIGKILL + exit');
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      process.exit(1);
    }

    // First signal: forward for graceful shutdown. If the child does
    // not exit within FORCE_KILL_MS, escalate to SIGKILL. SIGHUP
    // (terminal close) is treated as SIGTERM so the child runs its
    // shutdown — direct SIGHUP forwarding would kill the child without
    // letting it suspend sessions / flush state.
    const forwardSignal: 'SIGTERM' | 'SIGINT' = signal === 'SIGHUP' ? 'SIGTERM' : signal;
    try { child.kill(forwardSignal); } catch { /* ignore */ }
    const escalate = setTimeout(() => {
      if (child.killed) return;
      console.error(`[vinyan-supervisor] Child did not exit after ${FORCE_KILL_MS}ms — SIGKILL`);
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, FORCE_KILL_MS);
    (escalate as { unref?: () => void }).unref?.();

    // Belt-and-suspenders: even if SIGKILL somehow fails to terminate
    // the child (zombie, stuck in uninterruptible sleep, etc.) exit
    // the supervisor itself after SUPERVISOR_FORCE_EXIT_MS. The user's
    // Ctrl+C must always take effect within a bounded window.
    const forceExit = setTimeout(() => {
      console.error(`[vinyan-supervisor] Shutdown exceeded ${SUPERVISOR_FORCE_EXIT_MS}ms — forcing exit`);
      process.exit(1);
    }, SUPERVISOR_FORCE_EXIT_MS);
    (forceExit as { unref?: () => void }).unref?.();
  };
  process.on('SIGTERM', () => handleStop('SIGTERM'));
  process.on('SIGINT', () => handleStop('SIGINT'));
  // SIGHUP = terminal close. Without a handler the kernel default
  // would kill only us (not the child), orphaning the child with
  // nothing listening for graceful shutdown. Routing through handleStop
  // ensures the child shuts down cleanly, then we exit.
  process.on('SIGHUP', () => handleStop('SIGHUP'));

  // ── Hot reload: watch source files and SIGTERM the child on change ──
  if (watchMode) {
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const absolutePaths = WATCH_PATHS.map((p) => join(workspace, p));

    watcher = watch(absolutePaths, {
      ignored: (path) => shouldIgnore(path),
      ignoreInitial: true,
      persistent: true,
      usePolling: true,
      interval: 300,
    });

    const triggerReload = (changedPath: string) => {
      if (stopping || !currentChild) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (stopping || !currentChild) return;
        console.log(`[vinyan-supervisor] File changed: ${changedPath} — reloading server...`);
        reloadRequested = true;
        try {
          currentChild.kill('SIGTERM'); // let graceful shutdown run
        } catch {
          /* child already gone */
        }
      }, WATCH_DEBOUNCE_MS);
    };

    watcher.on('change', triggerReload);
    watcher.on('add', triggerReload);
    watcher.on('unlink', triggerReload);
    watcher.on('error', (err) => {
      console.error('[vinyan-supervisor] File watcher error:', err);
    });

    console.log('[vinyan-supervisor] Hot reload enabled — watching src/**/*.ts and vinyan.json');
  }

  console.log(
    `[vinyan-supervisor] Starting server (auto-restart enabled${watchMode ? ', hot reload on' : ''} — use --no-supervise to disable)`,
  );

  while (!stopping) {
    const startedAt = Date.now();
    reloadRequested = false;

    const child = spawn(bunExec, [scriptPath, ...rest], {
      stdio: ['ignore', 'inherit', 'inherit'],
      // VINYAN_SUPERVISED=1 tells index.ts the next dispatch should run
      // serve() directly instead of re-spawning the supervisor.
      // VINYAN_SUPERVISOR_PID lets the child's parent-death watchdog
      // self-terminate if we are SIGKILL'd without running our exit
      // handler — an essential zombie-free guarantee.
      env: {
        ...process.env,
        VINYAN_SUPERVISED: '1',
        VINYAN_SUPERVISOR_PID: String(process.pid),
      },
    });
    currentChild = child;
    // Signal forwarding is registered ONCE at the top of superviseServe
    // and reads `currentChild` at signal-time, so no per-iteration setup.

    const exitCode: number = await new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        resolve(code ?? (signal ? 128 : 0));
      });
    });
    const aliveMs = Date.now() - startedAt;
    currentChild = null;

    // Watch-triggered reload: we asked the child to exit; respawn immediately.
    if (reloadRequested && !stopping) {
      console.log(`[vinyan-supervisor] Reloading after file change (prev pid exited code=${exitCode})`);
      crashCount = 0;
      backoff = INITIAL_BACKOFF_MS;
      continue;
    }

    // Clean shutdown: child exited after user signal, or exited with 0.
    if (stopping || exitCode === 0) {
      console.log(`[vinyan-supervisor] Child exited cleanly (code=${exitCode}). Supervisor done.`);
      if (watcher) await watcher.close().catch(() => {});
      process.exit(exitCode ?? 0);
    }

    // Startup-fatal exit code: child told us explicitly "don't retry,
    // the user needs to fix something" (port bind, config, permissions).
    // Respawning would just reproduce the same error — infuriating the
    // user and wasting resources. Exit immediately with the child's code
    // so shell scripts can detect the specific failure.
    if (exitCode === EXIT_CODE_STARTUP_FATAL) {
      console.error(
        `[vinyan-supervisor] Child exited with startup-fatal code ${exitCode}. Not retrying — fix the error above and re-run.`,
      );
      if (watcher) await watcher.close().catch(() => {});
      process.exit(exitCode);
    }

    // Fast-fatal on first boot — e.g. config error, missing binary,
    // syntax error in generated code. Exponential-backoff loop would
    // burn through 20 respawns in minutes, generating a wall of
    // identical error output. Exit after one confirmation instead.
    if (aliveMs < FAST_FATAL_MS && crashCount === 0) {
      console.error(
        `[vinyan-supervisor] Child died in ${aliveMs}ms on first start (code=${exitCode}). ` +
          'Likely a startup error (port, config, permissions). Not retrying — fix and re-run.',
      );
      if (watcher) await watcher.close().catch(() => {});
      process.exit(exitCode);
    }

    // Reset backoff if the child was healthy for a while before crashing
    if (aliveMs > HEALTHY_THRESHOLD_MS) {
      crashCount = 0;
      backoff = INITIAL_BACKOFF_MS;
    } else {
      crashCount++;
    }

    if (crashCount >= MAX_CONSECUTIVE_CRASHES) {
      console.error(
        `[vinyan-supervisor] Child crashed ${crashCount} times in rapid succession — giving up. ` +
          'Fix the crash cause and restart manually.',
      );
      if (watcher) await watcher.close().catch(() => {});
      process.exit(1);
    }

    console.error(
      `[vinyan-supervisor] Child exited with code ${exitCode} after ${aliveMs}ms. ` +
        `Restarting in ${backoff}ms (crash #${crashCount})`,
    );
    await new Promise((resolve) => setTimeout(resolve, backoff));
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  }

  if (watcher) await watcher.close().catch(() => {});
}

// ── Helpers ─────────────────────────────────────────────────────────

function readSupervisorPid(path: string): number | null {
  try {
    if (!existsSync(path)) return null;
    const pid = parseInt(readFileSync(path, 'utf8').trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function writeSupervisorPid(path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, String(process.pid), 'utf8');
  } catch {
    // Non-fatal — PID file is convenience, not correctness.
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
